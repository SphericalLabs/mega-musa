/* Copyright (C) 2026 Sphericals
 * SPDX-License-Identifier: GPL-3.0-only WITH GPL-3.0-linking-exception
 * Photoshop/UXP linking permission: see LICENSE-EXCEPTION.
 */

// Offsets are relative to the viewport center, so resizing preserves the subject.
export class ReferencePreviewGeometry {
  width = 0;
  height = 0;
  zoom = 1;
  x = 0;
  y = 0;
  fitting = true;

  constructor(readonly imageWidth: number, readonly imageHeight: number) { }

  get fitZoom(): number {
    if (!this.width || !this.height) return 1;
    return Math.min(1, this.width / this.imageWidth, this.height / this.imageHeight);
  }

  get minZoom(): number { return Math.min(0.1, this.fitZoom); }
  get maxZoom(): number { return 8; }

  resize(width: number, height: number): void {
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
    this.width = width;
    this.height = height;
    if (this.fitting) this.fit();
    else this.clamp();
  }

  fit(): void {
    this.fitting = true;
    this.zoom = this.fitZoom;
    this.x = this.y = 0;
  }

  zoomTo(zoom: number): void {
    const next = Math.max(this.minZoom, Math.min(this.maxZoom, zoom));
    this.x *= next / this.zoom;
    this.y *= next / this.zoom;
    this.zoom = next;
    this.fitting = false;
    this.clamp();
  }

  pan(dx: number, dy: number): void {
    this.x += dx;
    this.y += dy;
    this.clamp();
  }

  private clamp(): void {
    const limitX = Math.max(0, (this.imageWidth * this.zoom - this.width) / 2);
    const limitY = Math.max(0, (this.imageHeight * this.zoom - this.height) / 2);
    this.x = limitX ? Math.max(-limitX, Math.min(limitX, this.x)) : 0;
    this.y = limitY ? Math.max(-limitY, Math.min(limitY, this.y)) : 0;
  }
}
