import { Fragment, type ReactNode } from "react";

/**
 * Renders WhatsApp's text formatting: *bold*, _italic_, ~strikethrough~,
 * ```monospace``` and line breaks. Everything else is plain text (React
 * escapes it), so nothing in a message can inject markup.
 */
export function WhatsAppText({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((line, i) => (
        <Fragment key={i}>
          {i > 0 && <br />}
          {format(line)}
        </Fragment>
      ))}
    </>
  );
}

const TOKEN = /```([^`]+)```|\*([^*\n]+)\*|_([^_\n]+)_|~([^~\n]+)~/g;

function format(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of line.matchAll(TOKEN)) {
    const at = m.index ?? 0;
    if (at > last) out.push(line.slice(last, at));
    const [, mono, bold, italic, strike] = m;
    const key = `${at}`;
    if (mono !== undefined) out.push(<code key={key}>{mono}</code>);
    else if (bold !== undefined)
      out.push(<strong key={key}>{format(bold)}</strong>);
    else if (italic !== undefined)
      out.push(<em key={key}>{format(italic)}</em>);
    else if (strike !== undefined) out.push(<s key={key}>{format(strike)}</s>);
    last = at + m[0].length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

export function time(date: Date): string {
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
