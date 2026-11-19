import type { ImageService, PromptService } from './assets.ts';
import {
  assertGenerationFitsCapability,
  type GenerationInput,
  type GenerationSnapshot,
  type ImageAsset,
  imageReferenceLabel,
  type ModelDefinition,
  type PromptAsset,
  type Reference,
  scanReferences,
} from './contracts.ts';
import { inputError } from './errors.ts';
import { ADAPTER_VERSION } from './openrouter.ts';

export type ResolveDeps = {
  prompts: PromptService;
  images: ImageService;
  configVersion: string;
};

/**
 * The single input truth: `{{prompt:UUID}}` expands in place and `{{image:UUID}}`
 * becomes its ordered `图 N` label in place, so the image model can read which
 * sentence a reference image belongs to. Inline references fix the image order by
 * first appearance; explicit inputs join the ordered list after them, keeping
 * their position but not appearing in the text. Names are display only. Malformed
 * or dangling references fail loudly instead of being sent upstream as plain
 * text.
 */
export function resolveSnapshot(deps: ResolveDeps, input: GenerationInput, model: ModelDefinition): GenerationSnapshot {
  let references: Reference[];
  try {
    references = scanReferences(input.authoredPrompt);
  } catch {
    throw inputError('malformed_reference', '素材引用语法损坏；请使用 {{prompt:UUID}} 或 {{image:UUID}}');
  }

  const promptAssets = new Map<string, PromptAsset>();
  const imageAssets = new Map<string, ImageAsset>();

  for (const reference of references) {
    if (reference.kind === 'prompt') {
      if (promptAssets.has(reference.id)) {
        continue;
      }
      const asset = deps.prompts.get(reference.id);
      if (asset === null) {
        throw inputError('missing_reference', '引用的 Prompt 素材不存在');
      }
      if (asset.deletedAt !== null) {
        throw inputError('missing_reference', '引用的 Prompt 素材已归档');
      }
      if (asset.body.includes('{{') || asset.body.includes('}}')) {
        throw inputError('recursive_reference', 'Prompt 素材包含引用语法，Phase 1 不支持递归引用');
      }
      promptAssets.set(reference.id, asset);
    } else {
      if (imageAssets.has(reference.id)) {
        continue;
      }
      const asset = deps.images.get(reference.id);
      if (asset === null) {
        throw inputError('missing_reference', '引用的图片素材不存在');
      }
      if (asset.deletedAt !== null) {
        throw inputError('missing_reference', '引用的图片素材已归档');
      }
      imageAssets.set(reference.id, asset);
    }
  }

  // Explicit intent-level inputs join the ordered list after the inline ones.
  for (const id of input.inputImages) {
    if (imageAssets.has(id)) {
      continue;
    }
    const asset = deps.images.get(id);
    if (asset === null) {
      throw inputError('missing_reference', '引用的输入图片不存在');
    }
    if (asset.deletedAt !== null) {
      throw inputError('missing_reference', '引用的输入图片已归档');
    }
    imageAssets.set(id, asset);
  }

  // Capability checks happen before any paid call: unsupported intent is
  // reported explicitly, never silently simulated (lossy abstraction).
  try {
    assertGenerationFitsCapability(model, input);
  } catch (error) {
    throw inputError('unsupported_capability', error instanceof Error ? error.message : '生成意图超出模型能力');
  }
  const imageRefs = [...imageAssets.values()];
  if (imageRefs.length > 0 && !model.capabilities.imageInput) {
    throw inputError('image_input_unsupported', '模型不支持输入图片');
  }
  if (imageRefs.length > model.capabilities.maxInputImages) {
    throw inputError('too_many_input_images', `输入图片数量超过模型上限（${model.capabilities.maxInputImages}）`);
  }

  // The ordered input list defines each image's 1-based ordinal: inline
  // references by first appearance, explicit inputs appended after them.
  const imageOrdinals = new Map<string, number>();
  let ordinal = 0;
  for (const id of imageAssets.keys()) {
    ordinal += 1;
    imageOrdinals.set(id, ordinal);
  }

  const resolvedPrompt = expandText(input.authoredPrompt, references, promptAssets, imageOrdinals);
  if (resolvedPrompt.trim().length === 0) {
    throw inputError('empty_prompt', '解析后的 Prompt 不能为空');
  }

  return {
    schemaVersion: 1,
    authored: input,
    resolvedPrompt,
    finalPrompt: resolvedPrompt,
    promptAssets: [...promptAssets.values()],
    imageAssets: [...imageAssets.values()],
    model,
    configVersion: deps.configVersion,
    requestSemantics: {
      adapterVersion: ADAPTER_VERSION,
      calls: input.outputCount,
      imagesPerCall: 1,
      appendedInstructions: [],
    },
  };
}

/** The label's own digits are ASCII; only those can fuse with a slot number. */
function isAsciiDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

function expandText(
  text: string,
  references: Reference[],
  promptAssets: Map<string, PromptAsset>,
  imageOrdinals: Map<string, number>,
): string {
  let result = '';
  let cursor = 0;
  for (const reference of references) {
    result += text.slice(cursor, reference.start);
    if (reference.kind === 'prompt') {
      const asset = promptAssets.get(reference.id);
      if (asset !== undefined) {
        result += asset.body;
      }
    } else {
      const label = imageOrdinals.get(reference.id);
      if (label !== undefined) {
        // The label ends in a digit, so it must stay delimited from digits the
        // author placed around the reference: `{{image:…}}2` is slot 1
        // followed by the digit 2, never "图 12".
        const leading = reference.start > 0 && isAsciiDigit(text.charCodeAt(reference.start - 1)) ? ' ' : '';
        const trailing = reference.end < text.length && isAsciiDigit(text.charCodeAt(reference.end)) ? ' ' : '';
        result += leading + imageReferenceLabel(label) + trailing;
      }
    }
    cursor = reference.end;
  }
  result += text.slice(cursor);
  return result;
}
