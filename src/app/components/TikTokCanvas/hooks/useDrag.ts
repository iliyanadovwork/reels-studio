'use client';

import { useRef, useEffect } from 'react';
import type { MutableRefObject } from 'react';
import { DISPLAY_SCALE, MIN_DIM, CANVAS_W } from '../constants';
import type { Box, Handle } from '../types';

// Crop-bar dragging, shared by both reel canvases: the top ('tc') and bottom ('bc') bars resize the video
// box vertically, and the draw loop + export clip to that box — so dragging a bar IS the crop. Neither
// canvas mounts anything else (no corners, no sides, no move/pan handle: the video is panned from the
// Adjust flyout), which is why this only knows the two vertical edges.

interface DragState {
  handle: Handle;
  sy: number;      // only the vertical cursor position matters — the box's width never changes
  sb: Box;
  scale: number;   // screen-px → canvas-px ratio captured at drag start (see startDrag)
}

interface UseDragParams {
  boxRef: MutableRefObject<Box>;
  setBox: (b: Box) => void;
  canvasRef: MutableRefObject<HTMLCanvasElement | null>;   // for the real on-screen scale (folds in CSS zoom)
  onChange?: () => void;   // fired once a drag ends, so the workspace can autosave the framing.
}

export function useDrag({ boxRef, setBox, canvasRef, onChange }: UseDragParams) {
  const drag = useRef<DragState | null>(null);
  const isDraggingRef = useRef(false);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    function applyDrag(dy: number, shiftKey: boolean) {
      if (!drag.current) return;
      const { handle: h, sb } = drag.current;
      // Shift resizes symmetrically about the box's centre; otherwise the opposite edge stays put.
      const nh = Math.max(MIN_DIM, shiftKey ? (h === 'tc' ? sb.h - dy * 2 : sb.h + dy * 2) : (h === 'tc' ? sb.h - dy : sb.h + dy));
      const ny = h === 'tc'
        ? (shiftKey ? sb.y + dy : sb.y + sb.h - nh)
        : (shiftKey ? sb.y - dy : sb.y);

      const b = { x: sb.x, y: ny, w: sb.w, h: nh };
      boxRef.current = b;
      setBox({ ...b });
    }

    function onMove(e: MouseEvent) {
      if (!drag.current) return;
      isDraggingRef.current = true;
      // Convert the screen-px delta to canvas px using the scale captured at drag start (the canvas's real
      // on-screen size ÷ CANVAS_W). A fixed DISPLAY_SCALE was wrong: the grid CSS-zooms the canvas wrapper
      // (zoom: fitFactor * viewScale), so the canvas is actually DISPLAY_SCALE × that on screen.
      applyDrag((e.clientY - drag.current.sy) / drag.current.scale, e.shiftKey);
    }
    function onUp() {
      const wasDragging = isDraggingRef.current;
      drag.current = null;
      isDraggingRef.current = false;
      if (wasDragging) onChangeRef.current?.();   // commit the framing
    }

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  function startDrag(e: React.MouseEvent, handle: Handle) {
    e.preventDefault();
    e.stopPropagation();
    // Measure the canvas's ACTUAL on-screen width to get the true screen→canvas ratio. getBoundingClientRect
    // already reflects whatever scaling is applied (the grid's CSS `zoom`, device pixel ratio, etc.), so the
    // drag stays 1:1 with the cursor at any preview zoom. Fall back to DISPLAY_SCALE if the rect isn't ready.
    const rect = canvasRef.current?.getBoundingClientRect();
    const scale = rect && rect.width > 0 ? rect.width / CANVAS_W : DISPLAY_SCALE;
    drag.current = {
      handle,
      sy: e.clientY,
      sb: { ...boxRef.current },
      scale,
    };
  }

  return { startDrag };
}
