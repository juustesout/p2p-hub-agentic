import { useRef, type ReactNode } from "react";
import { X, Minus } from "lucide-react";

export interface ManagedWindow {
  id: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minimized: boolean;
  render: () => ReactNode;
}

interface WindowManagerProps {
  windows: ManagedWindow[];
  setWindows: React.Dispatch<React.SetStateAction<ManagedWindow[]>>;
}

interface DragState {
  id: string;
  mode: "move" | "resize";
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origW: number;
  origH: number;
}

export function WindowManager({ windows, setWindows }: WindowManagerProps) {
  const dragRef = useRef<DragState | null>(null);

  const updateWindow = (id: string, patch: Partial<ManagedWindow>) => {
    setWindows((prev) =>
      prev.map((w) => (w.id === id ? { ...w, ...patch } : w)),
    );
  };

  const onPointerDown = (
    e: React.PointerEvent,
    id: string,
    mode: "move" | "resize",
  ) => {
    const win = windows.find((w) => w.id === id);
    if (!win) {
      return;
    }
    dragRef.current = {
      id,
      mode,
      startX: e.clientX,
      startY: e.clientY,
      origX: win.x,
      origY: win.y,
      origW: win.w,
      origH: win.h,
    };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent, id: string) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== id) {
      return;
    }
    const dx = e.clientX - drag.startX;
    const dy = e.clientY - drag.startY;
    if (drag.mode === "move") {
      updateWindow(id, { x: drag.origX + dx, y: drag.origY + dy });
    } else {
      updateWindow(id, {
        w: Math.max(320, drag.origW + dx),
        h: Math.max(240, drag.origH + dy),
      });
    }
  };

  const onPointerUp = (e: React.PointerEvent, id: string) => {
    const drag = dragRef.current;
    if (!drag || drag.id !== id || drag.mode !== "move") {
      dragRef.current = null;
      return;
    }
    const win = windows.find((w) => w.id === id);
    if (win) {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const snapped = snapPosition(e.clientX, e.clientY, vw, vh);
      if (snapped) {
        updateWindow(id, snapped);
      }
    }
    dragRef.current = null;
  };

  const close = (id: string) =>
    setWindows((prev) => prev.filter((w) => w.id !== id));

  const minimize = (id: string) => updateWindow(id, { minimized: true });

  const restore = (id: string) => updateWindow(id, { minimized: false });

  return (
    <div className="absolute inset-0 z-30">
      {windows.map((win) => {
        if (win.minimized) {
          return null;
        }
        return (
          <div
            key={win.id}
            className="absolute flex flex-col overflow-hidden rounded-xl border border-white/10 bg-slate-900/80 shadow-2xl shadow-black/50 backdrop-blur-xl"
            style={{ left: win.x, top: win.y, width: win.w, height: win.h }}
          >
            <div
              onPointerDown={(e) => onPointerDown(e, win.id, "move")}
              onPointerMove={(e) => onPointerMove(e, win.id)}
              onPointerUp={(e) => onPointerUp(e, win.id)}
              className="flex h-9 shrink-0 cursor-move select-none items-center justify-between border-b border-white/10 bg-white/5 px-3"
            >
              <span className="text-xs font-medium text-slate-300">{win.title}</span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => minimize(win.id)}
                  className="rounded-md p-1 text-slate-400 hover:bg-white/10"
                  aria-label="Minimize"
                >
                  <Minus size={14} />
                </button>
                <button
                  onClick={() => close(win.id)}
                  className="rounded-md p-1 text-slate-400 hover:bg-red-500/20 hover:text-red-300"
                  aria-label="Close"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">{win.render()}</div>
            <div
              onPointerDown={(e) => onPointerDown(e, win.id, "resize")}
              onPointerMove={(e) => onPointerMove(e, win.id)}
              onPointerUp={(e) => onPointerUp(e, win.id)}
              className="absolute bottom-0 right-0 h-4 w-4 cursor-nwse-resize"
            />
          </div>
        );
      })}

      {/* Minimized taskbar chips */}
      <div className="pointer-events-none absolute bottom-0 left-0 right-0 z-50 flex justify-center pb-24">
        <div className="pointer-events-auto flex gap-2">
          {windows
            .filter((w) => w.minimized)
            .map((win) => (
              <button
                key={win.id}
                onClick={() => restore(win.id)}
                className="rounded-xl border border-white/10 bg-slate-900/90 px-4 py-2 text-xs text-slate-300 backdrop-blur-xl hover:bg-white/10"
              >
                {win.title}
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}

function snapPosition(
  pointerX: number,
  pointerY: number,
  vw: number,
  vh: number,
): Partial<ManagedWindow> | null {
  const threshold = 8;
  if (pointerY < threshold) {
    return { x: 0, y: 0, w: vw, h: vh };
  }
  if (pointerX < threshold) {
    return { x: 0, y: 0, w: Math.floor(vw / 2), h: vh };
  }
  if (pointerX > vw - threshold) {
    return { x: Math.floor(vw / 2), y: 0, w: Math.ceil(vw / 2), h: vh };
  }
  return null;
}
