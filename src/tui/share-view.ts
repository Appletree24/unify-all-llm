import QRCode from 'qrcode';
import type { Screen } from './screen.js';

/** Two QR rows fit in one terminal row using Unicode half blocks. */
export class ShareView {
  private readonly rows: string[] = [];
  private link = false;

  constructor(readonly url: string) {
    const { modules } = QRCode.create(url, { errorCorrectionLevel: 'L' });
    const dark = (row: number, col: number) =>
      row >= 0 && col >= 0 && row < modules.size && col < modules.size && modules.get(row, col) ? 1 : 0;
    const blocks = [' ', '▀', '▄', '█'];
    for (let y = -4; y < modules.size + 4; y += 2) {
      let line = '';
      for (let x = -4; x < modules.size + 4; x++) line += blocks[dark(y, x) + 2 * dark(y + 1, x)];
      this.rows.push(line);
    }
  }

  toggleLink() { this.link = !this.link; }

  draw(screen: Screen) {
    const showQr = !this.link && screen.cols >= this.rows[0].length && screen.rows >= this.rows.length + 2;
    screen.put(1, 0, showQr ? '手机共享 · 用相机扫描二维码' : '手机共享 · 用手机浏览器打开链接', '1');
    if (showQr) {
      const left = Math.floor((screen.cols - this.rows[0].length) / 2);
      this.rows.forEach((line, i) => screen.put(left, i + 1, line, '38;2;0;0;0;48;2;255;255;255'));
    } else {
      const width = screen.cols - 2;
      for (let i = 0; i < this.url.length; i += width) screen.put(1, 2 + i / width, this.url.slice(i, i + width));
    }
    screen.put(1, screen.rows - 1, 'Esc 返回 · L 切换链接/二维码 · C 复制');
  }
}
