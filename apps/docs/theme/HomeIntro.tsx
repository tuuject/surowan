import { useLang, withBase } from '@rspress/core/runtime';
import { pageLink } from './links';
import { VersionNotice } from './VersionNotice';

/**
 * Where the home page sends readers. Both locales use the same files under the
 * same relative paths, so each destination is written once and the `/en` prefix
 * is only added when rendering.
 */
const DESTINATIONS = {
  persona: '/docs/guides/first-persona.html',
  models: '/docs/guides/models.html',
  tuning: '/docs/guides/tuning.html',
  troubleshooting: '/docs/guides/troubleshooting.html',
} as const;

type Destination = keyof typeof DESTINATIONS;

interface HomeIntroText {
  readonly ownBowl: {
    readonly heading: string;
    readonly lines: readonly string[];
    readonly link: { readonly href: Destination; readonly label: string };
  };
  readonly example: {
    readonly heading: string;
    readonly caption: string;
    readonly you: string;
    readonly speaker: string;
    /** One exchange: what the reader says, then how the bot answers. */
    readonly turns: readonly [string, string];
    readonly note: string;
  };
  readonly tasks: {
    readonly heading: string;
    readonly items: readonly { readonly href: Destination; readonly label: string; readonly detail: string }[];
  };
  readonly llms: string;
  readonly llmsFull: string;
}

/**
 * The home page prose that is not frontmatter. It is not generated per locale by
 * Rspress, so both languages live here; routes already carry the `/en` prefix the
 * site serves English pages under.
 */
const TEXT: Record<'zh' | 'en', HomeIntroText> = {
  zh: {
    ownBowl: {
      heading: '先写你想让它成为谁',
      lines: [
        '塑料碗只负责把消息送进模型：谁在说话、用什么语气、在哪些群里活跃，都来自你写的人格与规则。',
        '它可以在私聊、群组和话题里读消息、看图片、用贴纸，也可以选择不接话——沉默是模型的决定，不是故障。',
      ],
      link: { href: 'persona', label: '从写一份人格开始 →' },
    },
    example: {
      heading: '一段对话大致长这样',
      caption: '虚构示意，不是真实回复，也没有保存任何记忆',
      you: '你',
      speaker: '塑料碗',
      turns: ['这个群聊技术的时候再出声，别每句都接。', '好。有人问问题我再过来。'],
      note: '想让它长期保持？写进该群的附加指令，或者写进全局人格，而不是只说一次。',
    },
    tasks: {
      heading: '已经在运行了？',
      items: [
        { href: 'models', label: '换一个模型', detail: '供应商、三个模型角色与思考强度' },
        { href: 'tuning', label: '让它少说一点、便宜一点', detail: '消息批次、入场闸门与预算' },
        { href: 'troubleshooting', label: '为什么不回复', detail: '从消息可见性查到模型调用' },
      ],
    },
    llms: 'Agent 文档索引',
    llmsFull: '完整 Markdown',
  },
  en: {
    ownBowl: {
      heading: 'Write the bot you actually want',
      lines: [
        'Surowan only carries messages to the model. Who is speaking, in what tone, and in which chats all come from the persona and rules you write.',
        'It reads messages and images in private chats, groups and topics, can use stickers, and may stay quiet — silence is the model’s decision, not a failure.',
      ],
      link: { href: 'persona', label: 'Start with a persona →' },
    },
    example: {
      heading: 'A conversation might look like this',
      caption: 'Illustrative only; not a real reply and no memory is stored',
      you: 'You',
      speaker: 'Surowan',
      turns: [
        'Only speak up when something technical comes up — no need to answer every message.',
        'Understood. I’ll come over when someone asks.',
      ],
      note: 'Want it to stick? Put the rule in that chat’s extra instructions, or in the global persona — not in one passing message.',
    },
    tasks: {
      heading: 'Already running?',
      items: [
        { href: 'models', label: 'Switch models', detail: 'Providers, the three model roles and thinking effort' },
        { href: 'tuning', label: 'Talk less, spend less', detail: 'Message batches, the entry gate and budgets' },
        { href: 'troubleshooting', label: 'Why no reply?', detail: 'From message visibility to model calls' },
      ],
    },
    llms: 'Agent documentation index',
    llmsFull: 'Full Markdown',
  },
};

export function HomeIntro() {
  const lang = useLang() === 'en' ? 'en' : 'zh';
  const text = TEXT[lang];
  const prefix = lang === 'en' ? '/en' : '';
  const link = (destination: Destination): string => pageLink(`${prefix}${DESTINATIONS[destination]}`);
  return (
    <main className="home-intro">
      <div className="home-intro__columns">
        <section aria-labelledby="own-bowl">
          <h2 id="own-bowl">{text.ownBowl.heading}</h2>
          {text.ownBowl.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <a href={link(text.ownBowl.link.href)}>{text.ownBowl.link.label}</a>
        </section>
        <section className="home-intro__example" aria-labelledby="example-title">
          <h2 id="example-title">{text.example.heading}</h2>
          <p className="home-intro__caption">{text.example.caption}</p>
          <p>
            <strong>{text.example.you}</strong>
            <br />
            {text.example.turns[0]}
          </p>
          <p>
            <strong>{text.example.speaker}</strong>
            <br />
            {text.example.turns[1]}
          </p>
          <p className="home-intro__caption">{text.example.note}</p>
        </section>
      </div>
      <section className="home-intro__tasks" aria-labelledby="next-task">
        <h2 id="next-task">{text.tasks.heading}</h2>
        <ul>
          {text.tasks.items.map((item) => (
            <li key={item.href}>
              <a href={link(item.href)}>{item.label}</a> <span>{item.detail}</span>
            </li>
          ))}
        </ul>
      </section>
      <footer className="home-intro__footer">
        <VersionNotice />
        <p>
          <a href={withBase(`${prefix}/llms.txt`)}>{text.llms}</a> ·{' '}
          <a href={withBase(`${prefix}/llms-full.txt`)}>{text.llmsFull}</a>
        </p>
      </footer>
    </main>
  );
}
