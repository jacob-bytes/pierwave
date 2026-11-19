import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";

/**
 * 横向滚动容器 + 两侧渐隐。
 *
 * 只在确实溢出的一侧淡出内容，滚动到端点后该侧恢复；遮罩是纯视觉，
 * 不拦截点击，也不改变子元素尺寸。设置页与审计分类的长 tab 行共用它。
 */
export function ScrollFade({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({
    overflow: false,
    left: false,
    right: false,
  });

  useEffect(() => {
    const container = ref.current;
    if (!container) return;

    const update = () => {
      const overflow = container.scrollWidth > container.clientWidth + 1;
      setEdges({
        overflow,
        left: overflow && container.scrollLeft > 1,
        right:
          overflow &&
          container.scrollLeft + container.clientWidth <
            container.scrollWidth - 1,
      });
    };

    update();
    container.addEventListener("scroll", update, { passive: true });

    const resize = new ResizeObserver(update);
    resize.observe(container);
    const child = container.firstElementChild;
    if (child) resize.observe(child);

    const mutation = new MutationObserver(update);
    mutation.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    return () => {
      container.removeEventListener("scroll", update);
      resize.disconnect();
      mutation.disconnect();
    };
  }, []);

  const mask = edges.left
    ? edges.right
      ? "linear-gradient(to right, transparent 0, black 20px, black calc(100% - 20px), transparent 100%)"
      : "linear-gradient(to right, transparent 0, black 20px, black 100%)"
    : edges.right
      ? "linear-gradient(to right, transparent 0, black 0, black calc(100% - 20px), transparent 100%)"
      : undefined;

  return (
    <div
      ref={ref}
      data-slot="scroll-fade"
      data-overflowing={edges.overflow ? "true" : undefined}
      data-fade-left={edges.left ? "true" : undefined}
      data-fade-right={edges.right ? "true" : undefined}
      className={cn(
        "min-w-0 max-w-full overflow-x-auto overscroll-x-contain",
        className,
      )}
      style={
        mask
          ? { maskImage: mask, WebkitMaskImage: mask }
          : undefined
      }
    >
      {children}
    </div>
  );
}
