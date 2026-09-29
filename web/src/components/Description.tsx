import { useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { Modal } from "./ui";

export function Description({ body }: { body: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [open, setOpen] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [body]);

  return (
    <section className="card" aria-labelledby="desc-h">
      <div className="card-head">
        <h2 id="desc-h">Description</h2>
      </div>
      <div className="card-body description">
        <div ref={ref} className={`description-preview${overflows ? " clamped" : ""}`}>
          <Markdown source={body} />
        </div>
        {overflows && (
          <button
            type="button"
            className="button small ghost"
            aria-haspopup="dialog"
            onClick={() => setOpen(true)}
          >
            Read full description
          </button>
        )}
      </div>
      {open && (
        <Modal title="Description" onClose={() => setOpen(false)}>
          <Markdown source={body} />
        </Modal>
      )}
    </section>
  );
}
