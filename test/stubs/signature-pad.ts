// TEST-ONLY stand-in for signature_pad (same calls the app makes): draws strokes from
// pointer events on the canvas and reports whether anything has been drawn.
type Opts = { penColor?: string; backgroundColor?: string; minWidth?: number; maxWidth?: number };
export default class SignaturePad extends EventTarget {
  private empty = true;
  private drawing = false;
  private ctx: CanvasRenderingContext2D;
  constructor(
    private canvas: HTMLCanvasElement,
    private o: Opts = {},
  ) {
    super();
    this.ctx = canvas.getContext('2d')!;
    this.clear();
    canvas.addEventListener('pointerdown', this.down);
    window.addEventListener('pointermove', this.move);
    window.addEventListener('pointerup', this.up);
  }
  private pos(e: PointerEvent) {
    const r = this.canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }
  private down = (e: PointerEvent) => {
    this.drawing = true;
    const [x, y] = this.pos(e);
    this.ctx.beginPath();
    this.ctx.moveTo(x, y);
  };
  private move = (e: PointerEvent) => {
    if (!this.drawing) return;
    const [x, y] = this.pos(e);
    this.ctx.lineWidth = this.o.maxWidth || 2;
    this.ctx.strokeStyle = this.o.penColor || '#000';
    this.ctx.lineTo(x, y);
    this.ctx.stroke();
    this.empty = false;
  };
  private up = () => {
    if (!this.drawing) return;
    this.drawing = false;
    this.dispatchEvent(new Event('endStroke'));
  };
  isEmpty() {
    return this.empty;
  }
  clear() {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.fillStyle = this.o.backgroundColor || 'white';
    this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();
    this.empty = true;
  }
  toDataURL(type = 'image/png') {
    return this.canvas.toDataURL(type);
  }
  off() {
    this.canvas.removeEventListener('pointerdown', this.down);
    window.removeEventListener('pointermove', this.move);
    window.removeEventListener('pointerup', this.up);
  }
}
