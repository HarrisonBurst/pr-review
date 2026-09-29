import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const plugins = [remarkGfm];

const components: Components = {
  a: ({ node: _node, children, ...props }) => (
    <a {...props} target="_blank" rel="noreferrer nofollow">
      {children}
    </a>
  ),
  img: ({ node: _node, src, alt }) =>
    typeof src === "string" ? (
      <a href={src} target="_blank" rel="noreferrer nofollow" className="md-image">
        {alt || "Image"} ↗
      </a>
    ) : null,
  table: ({ node: _node, children, ...props }) => (
    <div className="md-table">
      <table {...props}>{children}</table>
    </div>
  ),
};

export const Markdown = ({
  source,
  components: extra,
}: {
  source: string;
  components?: Components;
}) => (
  <div className="markdown">
    <ReactMarkdown
      remarkPlugins={plugins}
      components={extra ? { ...components, ...extra } : components}
      skipHtml
    >
      {source}
    </ReactMarkdown>
  </div>
);
