"use client";

// A draggable divider between two panels — same pointer-capture drag
// pattern already used for timeline trim handles/scrubbing (see
// timeline-panel.tsx), applied to panel sizing instead of clip timing.
interface ResizeHandleProps {
  direction: "horizontal" | "vertical"; // horizontal = drag left/right to resize a width; vertical = drag up/down to resize a height
  onResize: (deltaPx: number) => void;
}

export function ResizeHandle({ direction, onResize }: ResizeHandleProps) {
  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    let last = direction === "horizontal" ? e.clientX : e.clientY;

    const onMove = (ev: PointerEvent) => {
      const pos = direction === "horizontal" ? ev.clientX : ev.clientY;
      onResize(pos - last);
      last = pos;
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div
      onPointerDown={onPointerDown}
      className={
        direction === "horizontal"
          ? "group relative w-1 shrink-0 cursor-col-resize select-none"
          : "group relative h-1 shrink-0 cursor-row-resize select-none"
      }
    >
      <div
        className={
          direction === "horizontal"
            ? "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/10 group-hover:bg-[#f26522] group-active:bg-[#f26522]"
            : "absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/10 group-hover:bg-[#f26522] group-active:bg-[#f26522]"
        }
      />
    </div>
  );
}
