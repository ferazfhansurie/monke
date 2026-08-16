"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// Chat text arrives from Claude as markdown — render it properly instead of
// dumping raw "**bold**" / "- bullet" characters into a wall of text.
export function Markdown({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        p: ({ children }) => <p className="mb-1.5 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-1.5 ml-3.5 list-disc space-y-0.5 marker:text-gray-600 last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-1.5 ml-3.5 list-decimal space-y-0.5 marker:text-gray-600 last:mb-0">{children}</ol>,
        li: ({ children }) => <li>{children}</li>,
        strong: ({ children }) => <strong className="font-semibold text-gray-100">{children}</strong>,
        em: ({ children }) => <em className="italic">{children}</em>,
        code: ({ children }) => <code className="rounded bg-white/10 px-1 py-0.5 font-mono text-[10.5px] text-[#f26522]/90">{children}</code>,
        h1: ({ children }) => <p className="mb-1 font-semibold text-gray-100">{children}</p>,
        h2: ({ children }) => <p className="mb-1 font-semibold text-gray-100">{children}</p>,
        h3: ({ children }) => <p className="mb-1 font-semibold text-gray-100">{children}</p>,
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noreferrer" className="underline decoration-dotted hover:text-[#f26522]">
            {children}
          </a>
        ),
        hr: () => <hr className="my-1.5 border-white/10" />,
        blockquote: ({ children }) => <blockquote className="border-l-2 border-white/15 pl-2 text-gray-400">{children}</blockquote>,
        table: ({ children }) => (
          <div className="mb-1.5 overflow-x-auto">
            <table className="border-collapse text-[11px]">{children}</table>
          </div>
        ),
        th: ({ children }) => <th className="border border-white/10 px-1.5 py-0.5 text-left font-semibold text-gray-200">{children}</th>,
        td: ({ children }) => <td className="border border-white/10 px-1.5 py-0.5">{children}</td>,
      }}
    >
      {text}
    </ReactMarkdown>
  );
}
