/** How a browser sign-in ended, as the page it comes back to says. */
export type SignInOutcome = 'signed-in' | 'refused' | 'invalid';

type Language = 'zh' | 'en';

const TEXT: Record<Language, Record<SignInOutcome, { title: string; body: string }> & { lang: string }> = {
  en: {
    lang: 'en',
    'signed-in': {
      title: 'Signed in to MoleSignal',
      body: 'You can close this tab and go back to the terminal.',
    },
    refused: {
      title: 'Sign-in not completed',
      body: 'The authorization was declined. Go back to the terminal and run `molesignal login` again.',
    },
    invalid: {
      title: 'Sign-in not completed',
      body: 'The browser came back without a valid code. Go back to the terminal and run `molesignal login` again.',
    },
  },
  zh: {
    lang: 'zh-CN',
    'signed-in': {
      title: '已登录 MoleSignal',
      body: '可以关闭这个页面，回到终端。',
    },
    refused: {
      title: '没有完成登录',
      body: '授权被拒绝了。回到终端，重新运行 `molesignal login`。',
    },
    invalid: {
      title: '没有完成登录',
      body: '浏览器带回的授权码无效。回到终端，重新运行 `molesignal login`。',
    },
  },
};

/** Chinese for a browser that asks for it first, English otherwise. */
export function pageLanguage(acceptLanguage: string | undefined): Language {
  const first = acceptLanguage?.split(',')[0]?.trim().toLowerCase() ?? '';
  return first.startsWith('zh') ? 'zh' : 'en';
}

const escape = (text: string) =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

/** A command in the text, set as code. */
const withCode = (text: string) => escape(text).replace(/`([^`]+)`/g, '<code>$1</code>');

const CHECK = '<path d="M5 12.5l4.2 4.2L19 7" />';
const CROSS = '<path d="M7 7l10 10M17 7L7 17" />';

/**
 * The page the browser lands on when it comes back to the command: the
 * terminal and MoleSignal joined (or not), and one sentence on what to do
 * next. It is set like MoleSignal's own sign-in and consent pages, in the
 * product's colours, light or dark as the system is.
 */
export function signInPage(outcome: SignInOutcome, language: Language): string {
  const text = TEXT[language];
  const { title, body } = text[outcome];
  const ok = outcome === 'signed-in';

  return `<!doctype html>
<html lang="${text.lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)} · MoleSignal</title>
<style>
  :root {
    color-scheme: light dark;
    --bg-0: #fbfbfd; --bg-1: #f5f7fb; --bg-2: #eef0f5; --bd-0: #e0e4ed;
    --tx-0: #131825; --tx-2: #5a617e;
    --indigo: #3742c7; --blue: #1967b9; --green: #017737;
    --ok-ink: #017737; --ok-tint: #e7f2eb; --no-ink: #97101b; --no-tint: rgba(161, 15, 28, 0.10);
    --wash-a: rgba(55, 66, 199, 0.11); --wash-b: rgba(1, 119, 55, 0.08); --dot: rgba(19, 24, 37, 0.08);
    --shadow: 0 20px 60px rgba(19, 24, 37, 0.12);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg-0: #0d101a; --bg-1: #131725; --bg-2: #1a1f30; --bd-0: #1b2031;
      --tx-0: #ecedf3; --tx-2: #8b90a4;
      --indigo: #4f60e0; --blue: #4d97e0; --green: #3dc26e;
      --ok-ink: #66d28e; --ok-tint: rgba(61, 194, 110, 0.14); --no-ink: #ff8f89; --no-tint: rgba(247, 135, 132, 0.16);
      --wash-a: rgba(79, 96, 224, 0.20); --wash-b: rgba(61, 194, 110, 0.12); --dot: rgba(236, 237, 243, 0.06);
      --shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    }
  }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center; padding: 40px 16px;
    background:
      radial-gradient(60vmax 60vmax at 0% 0%, var(--wash-a), transparent 70%),
      radial-gradient(60vmax 60vmax at 100% 100%, var(--wash-b), transparent 70%),
      radial-gradient(var(--dot) 1px, transparent 1px) 0 0 / 22px 22px,
      var(--bg-0);
    color: var(--tx-0);
    font-family: "Alibaba PuHuiTi 3.0", "PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    font-weight: 500;
  }
  main { width: 100%; max-width: 440px; display: flex; flex-direction: column; align-items: center; }
  .marks { display: flex; align-items: center; gap: 12px; }
  .mark { width: 48px; height: 48px; border-radius: 12px; display: grid; place-items: center; background: var(--bg-1); box-shadow: var(--shadow); }
  .mark svg { display: block; }
  .link { display: flex; align-items: center; gap: 6px; }
  .dots { width: 24px; border-top: 2px dotted var(--bd-0); }
  .state { width: 24px; height: 24px; border-radius: 999px; display: grid; place-items: center; }
  .state svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
  .ok { background: var(--ok-tint); color: var(--ok-ink); }
  .no { background: var(--no-tint); color: var(--no-ink); }
  .card { margin-top: 28px; width: 100%; padding: 32px; border: 1px solid var(--bd-0); border-radius: 16px; background: var(--bg-1); box-shadow: var(--shadow); text-align: center; }
  h1 { margin: 0; font-size: 20px; font-weight: 600; letter-spacing: -0.01em; }
  p { margin: 8px 0 0; color: var(--tx-2); font-size: 13px; line-height: 1.6; }
  code { padding: 1px 6px; border-radius: 6px; background: var(--bg-2); color: var(--tx-0); font: 12px/1.6 "SF Mono", Menlo, Consolas, monospace; }
  footer { margin-top: 24px; color: var(--tx-2); font-size: 12px; }
</style>
</head>
<body>
<main>
  <div class="marks" aria-hidden="true">
    <span class="mark">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--tx-0)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8l4 4-4 4"/><path d="M12 17h7"/></svg>
    </span>
    <span class="link">
      <span class="dots"></span>
      <span class="state ${ok ? 'ok' : 'no'}"><svg viewBox="0 0 24 24">${ok ? CHECK : CROSS}</svg></span>
      <span class="dots"></span>
    </span>
    <span class="mark">
      <svg width="30" height="30" viewBox="0 0 32 32" fill="none">
        <defs><linearGradient id="ecg" x1="0" y1="16" x2="32" y2="16" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stop-color="var(--indigo)"/><stop offset="50%" stop-color="var(--blue)"/><stop offset="100%" stop-color="var(--green)"/>
        </linearGradient></defs>
        <path d="M0 16 H8 L10 17.5 L13 4 L18 28 L21.5 13 L23 16 H32" stroke="url(#ecg)" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </span>
  </div>
  <section class="card">
    <h1>${escape(title)}</h1>
    <p>${withCode(body)}</p>
  </section>
  <footer>MoleSignal CLI</footer>
</main>
</body>
</html>`;
}
