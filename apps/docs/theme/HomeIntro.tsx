import { useLang, withBase } from '@rspress/core/runtime';
import { pageLink } from './links';
import { VersionNotice } from './VersionNotice';

interface HomeIntroText {
  readonly ownBowl: { readonly heading: string; readonly lines: readonly string[]; readonly link: string };
  readonly example: {
    readonly heading: string;
    readonly caption: string;
    readonly you: string;
    readonly speaker: string;
    readonly turns: readonly string[];
    readonly note: string;
  };
  readonly tasks: {
    readonly heading: string;
    readonly items: readonly { readonly href: string; readonly label: string; readonly detail: string }[];
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
      heading: '一只碗，各有各的性格',
      lines: [
        '在私聊、群组和 Topic 里，用你选择的模型、人格和参与方式，让对话自然发生。',
        '它可以看图、使用贴纸、按会话记住一些事；是否开口由模型决定，不是每条消息必回。',
      ],
      link: '从写一份人格开始 →',
    },
    example: {
      heading: '对话可以这样开始',
      caption: '虚构示意，不代表实际回复或已保存的记忆',
      you: '你',
      speaker: '塑料碗',
      turns: ['碗，以后在这个群里话少一点，遇到技术问题再搭把手。', '好，我先在旁边待着。需要时叫我。'],
      note: '想长期保持？将规则写进该群的附加指令，而不只依赖一次聊天。',
    },
    tasks: {
      heading: '已经跑起来了？',
      items: [
        { href: '/docs/guides/chats.html', label: '给不同群配置不同的碗', detail: '模型、指令与参与时段' },
        { href: '/docs/guides/knowledge.html', label: '管理记忆与遗忘', detail: '短期记忆、TTL 与人工整理' },
        { href: '/docs/guides/tuning.html', label: '控制用量', detail: '全局预算与运行限制' },
        { href: '/docs/guides/images.html', label: '让碗画图', detail: '启用生图、聊天改图与图片管理' },
        { href: '/docs/guides/troubleshooting.html', label: '排查为什么不回复', detail: '从消息可见性到模型调用' },
      ],
    },
    llms: 'Agent 文档索引',
    llmsFull: '完整 Markdown',
  },
  en: {
    ownBowl: {
      heading: 'One bowl, its own personality',
      lines: [
        'Pick the models, persona and participation rules, and let conversations happen in private chats, groups and forum topics.',
        'It can look at images, use stickers and remember a few things per conversation. Whether it speaks is the model’s decision, not a reply to every message.',
      ],
      link: 'Start with a persona →',
    },
    example: {
      heading: 'A conversation might begin like this',
      caption: 'Illustrative only; not a real reply and not a stored memory',
      you: 'You',
      speaker: 'Surowan',
      turns: [
        'Stay quiet in this group from now on, and pitch in when there is a technical question.',
        'Understood. I’ll sit this one out until you call me.',
      ],
      note: 'Want it to stick? Write the rule into that chat’s extra instructions instead of relying on one conversation.',
    },
    tasks: {
      heading: 'Already running?',
      items: [
        {
          href: '/docs/guides/chats.html',
          label: 'Different behaviour per chat',
          detail: 'Models, instructions and active hours',
        },
        {
          href: '/docs/guides/knowledge.html',
          label: 'Manage memory and forgetting',
          detail: 'Short-term memory, TTL and manual review',
        },
        { href: '/docs/guides/tuning.html', label: 'Control usage', detail: 'Global budgets and run limits' },
        {
          href: '/docs/guides/images.html',
          label: 'Let it draw',
          detail: 'Turn on image generation, edit images in chat, manage assets',
        },
        {
          href: '/docs/guides/troubleshooting.html',
          label: 'Why no reply?',
          detail: 'From message visibility to model calls',
        },
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
  const link = (href: string): string => pageLink(`${prefix}${href}`);
  return (
    <main className="home-intro">
      <div className="home-intro__columns">
        <section aria-labelledby="own-bowl">
          <h2 id="own-bowl">{text.ownBowl.heading}</h2>
          {text.ownBowl.lines.map((line) => (
            <p key={line}>{line}</p>
          ))}
          <a href={link('/docs/guides/first-persona.html')}>{text.ownBowl.link}</a>
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
