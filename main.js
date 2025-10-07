/**
 * PaintMasterJS - A comprehensive JavaScript painting library for HTML5 Canvas.
 * 
 * Designed to provide:
 * - Layered painting with blend modes
 * - Multiple brush types (round, flat, calligraphy, airbrush, texture, smudge, scatter)
 * - Dynamic brush parameters (size, flow, opacity, hardness, spacing)
 * - Pressure support via Pointer Events (simulated fallback)
 * - 100+ prebuilt color presets & palettes, plus HSL/HSV conversion utilities
 * - Depth/relief effects via pseudo-normal maps and height maps
 * - Undo/redo history with command-based architecture
 * - Texture maps, pattern fills, and custom scatter sources
 * - Performance-minded batching for strokes and smoothed input (Bezier, Catmull-Rom)
 * - Exporting layers and composite images (PNG/JPEG/WebP)
 * - Simple UMD wrapper allowing usage with ES Modules, CommonJS, or global window
 * 
 * This file is written in English and includes extensive inline documentation.
 * 
 * Note:
 * - The depth effects are simulated techniques leveraging composite stamping and shadows.
 * - Brushes are extensible; users can define custom brushes via the BrushEngine API.
 * - The library focuses on canvas 2D; WebGL is not required.
 * 
 * Author: Copilot
 * License: MIT
 */

(function (root, factory) {
  if (typeof module === "object" && typeof module.exports === "object") {
    module.exports = factory();
  } else if (typeof define === "function" && define.amd) {
    define([], factory);
  } else {
    root.PaintMasterJS = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // =========================================================================================
  // Utility Section
  // =========================================================================================

  /**
   * Simple assertion utility for development-time checks.
   */
  function assert(condition, message) {
    if (!condition) {
      throw new Error(message || "Assertion failed");
    }
  }

  /**
   * Clamp a number within [min, max].
   */
  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  /**
   * Linear interpolation between two values a and b by t in [0,1].
   */
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }

  /**
   * Euclidean distance between two points.
   */
  function distance(x1, y1, x2, y2) {
    const dx = x2 - x1;
    const dy = y2 - y1;
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * Returns a random float in [min, max].
   */
  function randFloat(min, max) {
    return Math.random() * (max - min) + min;
  }

  /**
   * Returns a random integer in [min, max].
   */
  function randInt(min, max) {
    return (Math.random() * (max - min + 1)) | 0 + min;
  }

  /**
   * Generate a UUID v4-like string.
   */
  function uuid() {
    // Lightweight, not cryptographically strong
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
      const r = (Math.random() * 16) | 0;
      const v = c === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  /**
   * Create an offscreen canvas with specified dimensions.
   */
  function createOffscreenCanvas(width, height) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }

  /**
   * Convert degrees to radians.
   */
  function deg2rad(deg) {
    return (deg * Math.PI) / 180;
  }

  /**
   * Convert radians to degrees.
   */
  function rad2deg(rad) {
    return (rad * 180) / Math.PI;
  }

  /**
   * Smooth step (Hermite interpolation) function.
   */
  function smoothstep(edge0, edge1, x) {
    const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  /**
   * Catmull-Rom spline interpolation for smoothing stroke points.
   * Returns an array of interpolated points.
   */
  function catmullRomSpline(points, alpha = 0.5, resolution = 16) {
    if (points.length < 2) return points.slice();
    const result = [];
    // Duplicate endpoints for boundary conditions
    const pts = points.slice();
    pts.unshift(points[0]);
    pts.push(points[points.length - 1]);

    for (let i = 1; i < pts.length - 2; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2];

      for (let t = 0; t <= 1; t += 1 / resolution) {
        const t2 = t * t;
        const t3 = t2 * t;

        const x =
          0.5 *
          ((2 * p1.x) +
            (-p0.x + p2.x) * t +
            (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
            (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);

        const y =
          0.5 *
          ((2 * p1.y) +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);

        result.push({ x, y, pressure: lerp(p1.pressure, p2.pressure, t) });
      }
    }

    return result;
  }

  /**
   * Bezier interpolation for stroke smoothing.
   * Quadratic Bezier: returns array of points given p0, p1, p2.
   */
  function quadraticBezier(p0, p1, p2, resolution = 16) {
    const points = [];
    for (let t = 0; t <= 1; t += 1 / resolution) {
      const x = (1 - t) * (1 - t) * p0.x + 2 * (1 - t) * t * p1.x + t * t * p2.x;
      const y = (1 - t) * (1 - t) * p0.y + 2 * (1 - t) * t * p1.y + t * t * p2.y;
      const pressure = lerp(p0.pressure || 0.5, p2.pressure || 0.5, t);
      points.push({ x, y, pressure });
    }
    return points;
  }

  /**
   * Convert RGB components to HEX string.
   */
  function rgbToHex(r, g, b) {
    const toHex = (v) => {
      const h = clamp(v | 0, 0, 255).toString(16).padStart(2, "0");
      return h;
    };
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
  }

  /**
   * Convert HEX string to RGB components.
   */
  function hexToRgb(hex) {
    let h = hex.replace("#", "");
    if (h.length === 3) {
      h = h.split("").map((c) => c + c).join("");
    }
    const bigint = parseInt(h, 16);
    return {
      r: (bigint >> 16) & 255,
      g: (bigint >> 8) & 255,
      b: bigint & 255,
    };
  }

  /**
   * Convert HSV to RGB.
   * h in [0,360], s in [0,1], v in [0,1].
   */
  function hsvToRgb(h, s, v) {
    const c = v * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = v - c;
    let r = 0,
      g = 0,
      b = 0;

    if (0 <= h && h < 60) {
      r = c;
      g = x;
      b = 0;
    } else if (60 <= h && h < 120) {
      r = x;
      g = c;
      b = 0;
    } else if (120 <= h && h < 180) {
      r = 0;
      g = c;
      b = x;
    } else if (180 <= h && h < 240) {
      r = 0;
      g = x;
      b = c;
    } else if (240 <= h && h < 300) {
      r = x;
      g = 0;
      b = c;
    } else {
      r = c;
      g = 0;
      b = x;
    }

    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255),
    };
  }

  /**
   * Convert HSL to RGB.
   * h in [0,360], s in [0,1], l in [0,1].
   */
  function hslToRgb(h, s, l) {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    let r = 0,
      g = 0,
      b = 0;

    if (0 <= h && h < 60) {
      r = c;
      g = x;
      b = 0;
    } else if (60 <= h && h < 120) {
      r = x;
      g = c;
      b = 0;
    } else if (120 <= h && h < 180) {
      r = 0;
      g = c;
      b = x;
    } else if (180 <= h && h < 240) {
      r = 0;
      g = x;
      b = c;
    } else if (240 <= h && h < 300) {
      r = x;
      g = 0;
      b = c;
    } else {
      r = c;
      g = 0;
      b = x;
    }

    return {
      r: Math.round((r + m) * 255),
      g: Math.round((g + m) * 255),
      b: Math.round((b + m) * 255),
    };
  }

  /**
   * Convert RGB to HSL.
   */
  function rgbToHsl(r, g, b) {
    r /= 255;
    g /= 255;
    b /= 255;

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    let h = 0,
      s = 0;
    const l = (max + min) / 2;

    if (max === min) {
      h = s = 0;
    } else {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r:
          h = (g - b) / d + (g < b ? 6 : 0);
          break;
        case g:
          h = (b - r) / d + 2;
          break;
        case b:
          h = (r - g) / d + 4;
          break;
      }
      h *= 60;
    }

    return { h, s, l };
  }

  /**
   * Compose an RGBA string from components.
   */
  function rgba(r, g, b, a) {
    return `rgba(${r | 0},${g | 0},${b | 0},${clamp(a, 0, 1)})`;
  }

  /**
   * Deep clone via JSON for simple data.
   */
  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  /**
   * Create a 1D Gaussian kernel.
   */
  function gaussianKernel(size, sigma) {
    const kernel = [];
    const center = (size - 1) / 2;
    let sum = 0;
    for (let i = 0; i < size; i++) {
      const x = i - center;
      const val = Math.exp(-(x * x) / (2 * sigma * sigma));
      kernel[i] = val;
      sum += val;
    }
    // Normalize
    for (let i = 0; i < size; i++) kernel[i] /= sum;
    return kernel;
  }

  /**
   * Apply Gaussian blur to an ImageData object (separable kernel).
   */
  function gaussianBlurImageData(imageData, radius) {
    const { width, height, data } = imageData;
    const sigma = Math.max(radius / 2, 0.1);
    const ksz = Math.max(3, (radius | 0) * 2 + 1);
    const kernel = gaussianKernel(ksz, sigma);

    const tmp = new Uint8ClampedArray(data.length);

    // Horizontal pass
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let r = 0,
          g = 0,
          b = 0,
          a = 0;
        for (let k = 0; k < ksz; k++) {
          const dx = clamp(x + k - ((ksz - 1) / 2) | 0, 0, width - 1);
          const idx = (y * width + dx) * 4;
          const w = kernel[k];
          r += data[idx] * w;
          g += data[idx + 1] * w;
          b += data[idx + 2] * w;
          a += data[idx + 3] * w;
        }
        const outIdx = (y * width + x) * 4;
        tmp[outIdx] = r;
        tmp[outIdx + 1] = g;
        tmp[outIdx + 2] = b;
        tmp[outIdx + 3] = a;
      }
    }

    // Vertical pass
    const out = new Uint8ClampedArray(data.length);
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        let r = 0,
          g = 0,
          b = 0,
          a = 0;
        for (let k = 0; k < ksz; k++) {
          const dy = clamp(y + k - ((ksz - 1) / 2) | 0, 0, height - 1);
          const idx = (dy * width + x) * 4;
          const w = kernel[k];
          r += tmp[idx] * w;
          g += tmp[idx + 1] * w;
          b += tmp[idx + 2] * w;
          a += tmp[idx + 3] * w;
        }
        const outIdx = (y * width + x) * 4;
        out[outIdx] = r;
        out[outIdx + 1] = g;
        out[outIdx + 2] = b;
        out[outIdx + 3] = a;
      }
    }

    return new ImageData(out, width, height);
  }

  /**
   * Compute a simple normal map from a height map ImageData.
   * Returns ImageData with normals encoded in RGB.
   */
  function heightToNormalMap(imageData, strength = 1.0) {
    const { width, height, data } = imageData;
    const out = new Uint8ClampedArray(data.length);

    function heightAt(x, y) {
      const idx = (y * width + x) * 4;
      // Use luminance as height
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      // Simple luma approximation
      return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
    }

    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const dx = (heightAt(x + 1, y) - heightAt(x - 1, y)) * strength;
        const dy = (heightAt(x, y + 1) - heightAt(x, y - 1)) * strength;

        // Normal vector components (z is up)
        let nx = -dx;
        let ny = -dy;
        let nz = 1.0;

        // Normalize
        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1.0;
        nx /= len;
        ny /= len;
        nz /= len;

        const idx = (y * width + x) * 4;
        // Encode to RGB [0..255]
        out[idx] = ((nx * 0.5 + 0.5) * 255) | 0;
        out[idx + 1] = ((ny * 0.5 + 0.5) * 255) | 0;
        out[idx + 2] = ((nz * 0.5 + 0.5) * 255) | 0;
        out[idx + 3] = 255;
      }
    }

    return new ImageData(out, width, height);
  }

  /**
   * Apply a simple directional light on a normal map to produce shading.
   */
  function shadeFromNormalMap(normalMap, lightDir = { x: 0.5, y: -0.5, z: 1.0 }, ambient = 0.2) {
    const { width, height, data } = normalMap;
    const out = new Uint8ClampedArray(data.length);

    function dot(ax, ay, az, bx, by, bz) {
      return ax * bx + ay * by + az * bz;
    }
    const lenLight = Math.sqrt(lightDir.x ** 2 + lightDir.y ** 2 + lightDir.z ** 2) || 1;
    const lx = lightDir.x / lenLight;
    const ly = lightDir.y / lenLight;
    const lz = lightDir.z / lenLight;

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const nx = (data[idx] / 255) * 2 - 1;
        const ny = (data[idx + 1] / 255) * 2 - 1;
        const nz = (data[idx + 2] / 255) * 2 - 1;

        const diff = clamp(dot(nx, ny, nz, lx, ly, lz), 0, 1);
        const shade = ambient + (1 - ambient) * diff;
        const val = (shade * 255) | 0;

        out[idx] = val;
        out[idx + 1] = val;
        out[idx + 2] = val;
        out[idx + 3] = 255;
      }
    }

    return new ImageData(out, width, height);
  }

  /**
   * Blend an ImageData into a target canvas context at position (x, y) with a given globalAlpha.
   */
  function drawImageData(ctx, imageData, x = 0, y = 0, alpha = 1.0) {
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = alpha;
    ctx.putImageData(imageData, x, y);
    ctx.globalAlpha = prevAlpha;
  }

  /**
   * Composite one canvas onto another with a given globalCompositeOperation and alpha.
   */
  function compositeCanvas(sourceCanvas, targetCtx, x = 0, y = 0, gco = "source-over", alpha = 1.0) {
    const prevGCO = targetCtx.globalCompositeOperation;
    const prevAlpha = targetCtx.globalAlpha;
    targetCtx.globalCompositeOperation = gco;
    targetCtx.globalAlpha = alpha;
    targetCtx.drawImage(sourceCanvas, x, y);
    targetCtx.globalAlpha = prevAlpha;
    targetCtx.globalCompositeOperation = prevGCO;
  }

  // =========================================================================================
  // Color Presets and Palette
  // =========================================================================================

  /**
   * Generate a 100-color palette using HSV circular distribution with controlled saturation/value bands.
   */
  function generatePresetPalette(count = 100) {
    const palette = [];
    for (let i = 0; i < count; i++) {
      const h = (360 * i) / count;
      const band = i % 5;
      const s = [0.95, 0.85, 0.75, 0.6, 0.45][band];
      const v = [0.95, 0.85, 0.75, 0.65, 0.55][band];
      const { r, g, b } = hsvToRgb(h, s, v);
      palette.push({
        name: `Color ${i + 1}`,
        hex: rgbToHex(r, g, b),
        r,
        g,
        b,
        h,
        s,
        v,
      });
    }
    return palette;
  }

  const PRESET_PALETTE_100 = generatePresetPalette(100);

  /**
   * ColorPalette provides color management utilities and a catalog of presets.
   */
  class ColorPalette {
    constructor(customColors = []) {
      this.presets = PRESET_PALETTE_100.map((c) => deepClone(c));
      this.custom = customColors.map((c) => this.normalizeColor(c));
    }

    normalizeColor(color) {
      if (typeof color === "string") {
        const { r, g, b } = hexToRgb(color);
        return { r, g, b, a: 1, hex: color };
      }
      const r = clamp(color.r || 0, 0, 255);
      const g = clamp(color.g || 0, 0, 255);
      const b = clamp(color.b || 0, 0, 255);
      const a = clamp(color.a == null ? 1 : color.a, 0, 1);
      return { r, g, b, a, hex: rgbToHex(r, g, b) };
    }

    addCustom(color) {
      const normalized = this.normalizeColor(color);
      this.custom.push(normalized);
      return normalized;
    }

    getPreset(index) {
      return this.presets[index % this.presets.length];
    }

    getAllPresets() {
      return this.presets.slice();
    }

    toRGBA(color) {
      const c = this.normalizeColor(color);
      return rgba(c.r, c.g, c.b, c.a == null ? 1 : c.a);
    }

    lighten(color, amount = 0.1) {
      const c = this.normalizeColor(color);
      const { h, s, l } = rgbToHsl(c.r, c.g, c.b);
      const nl = clamp(l + amount, 0, 1);
      const { r, g, b } = hslToRgb(h, s, nl);
      return { r, g, b, a: c.a, hex: rgbToHex(r, g, b) };
    }

    darken(color, amount = 0.1) {
      const c = this.normalizeColor(color);
      const { h, s, l } = rgbToHsl(c.r, c.g, c.b);
      const nl = clamp(l - amount, 0, 1);
      const { r, g, b } = hslToRgb(h, s, nl);
      return { r, g, b, a: c.a, hex: rgbToHex(r, g, b) };
    }

    shiftHue(color, delta = 30) {
      const c = this.normalizeColor(color);
      const { h, s, l } = rgbToHsl(c.r, c.g, c.b);
      const nh = (h + delta + 360) % 360;
      const { r, g, b } = hslToRgb(nh, s, l);
      return { r, g, b, a: c.a, hex: rgbToHex(r, g, b) };
    }
  }

  // =========================================================================================
  // Layer Management
  // =========================================================================================

  /**
   * Layer represents a single paintable canvas with properties and blend mode.
   */
  class Layer {
    constructor(width, height, options = {}) {
      assert(width > 0 && height > 0, "Layer requires positive dimensions");
      this.id = uuid();
      this.name = options.name || `Layer ${this.id.substring(0, 8)}`;
      this.visible = options.visible ?? true;
      this.opacity = clamp(options.opacity ?? 1.0, 0, 1);
      this.blendMode = options.blendMode || "source-over";
      this.canvas = createOffscreenCanvas(width, height);
      this.ctx = this.canvas.getContext("2d");
      this.locked = options.locked ?? false;
      this.isReference = options.isReference ?? false; // Reference layer not affected by edits
      this.depthCanvas = createOffscreenCanvas(width, height); // For height/depth effects
      this.depthCtx = this.depthCanvas.getContext("2d");
      this.meta = options.meta || {};
      this.clear();
    }

    clear() {
      const { width, height } = this.canvas;
      this.ctx.clearRect(0, 0, width, height);
      this.depthCtx.clearRect(0, 0, width, height);
    }

    resize(width, height) {
      const oldCanvas = this.canvas;
      const oldDepth = this.depthCanvas;
      const tmp = createOffscreenCanvas(width, height);
      const tmpCtx = tmp.getContext("2d");

      tmpCtx.drawImage(oldCanvas, 0, 0, width, height);

      const tmpDepth = createOffscreenCanvas(width, height);
      const tmpDepthCtx = tmpDepth.getContext("2d");
      tmpDepthCtx.drawImage(oldDepth, 0, 0, width, height);

      this.canvas = tmp;
      this.ctx = tmpCtx;
      this.depthCanvas = tmpDepth;
      this.depthCtx = tmpDepthCtx;
    }
  }

  /**
   * LayerManager handles a stack of layers, ordering, visibility, and blending.
   */
  class LayerManager {
    constructor(width, height) {
      this.width = width;
      this.height = height;
      this.layers = [];
      this.activeLayerIndex = -1;
      this.backgroundColor = "#ffffff";
      this.compositeCanvas = createOffscreenCanvas(width, height);
      this.compositeCtx = this.compositeCanvas.getContext("2d");
    }

    addLayer(options = {}) {
      const layer = new Layer(this.width, this.height, options);
      this.layers.push(layer);
      if (this.activeLayerIndex === -1) {
        this.activeLayerIndex = 0;
      }
      return layer;
    }

    insertLayer(index, options = {}) {
      const layer = new Layer(this.width, this.height, options);
      this.layers.splice(index, 0, layer);
      this.activeLayerIndex = index;
      return layer;
    }

    removeLayer(index) {
      if (index < 0 || index >= this.layers.length) return null;
      const [removed] = this.layers.splice(index, 1);
      this.activeLayerIndex = clamp(this.activeLayerIndex, 0, this.layers.length - 1);
      return removed;
    }

    moveLayer(fromIndex, toIndex) {
      if (fromIndex === toIndex) return;
      const l = this.layers.splice(fromIndex, 1)[0];
      this.layers.splice(toIndex, 0, l);
      this.activeLayerIndex = toIndex;
    }

    getActiveLayer() {
      if (this.activeLayerIndex < 0 || this.activeLayerIndex >= this.layers.length) return null;
      return this.layers[this.activeLayerIndex];
    }

    setActiveLayer(index) {
      if (index < 0 || index >= this.layers.length) return;
      this.activeLayerIndex = index;
    }

    compositeTo(ctx) {
      const { width, height } = this.compositeCanvas;
      // Clear composite
      this.compositeCtx.save();
      this.compositeCtx.globalCompositeOperation = "source-over";
      this.compositeCtx.globalAlpha = 1.0;
      this.compositeCtx.fillStyle = this.backgroundColor;
      this.compositeCtx.fillRect(0, 0, width, height);
      this.compositeCtx.restore();

      // Draw each visible layer
      for (const layer of this.layers) {
        if (!layer.visible) continue;
        compositeCanvas(layer.depthCanvas, this.compositeCtx, 0, 0, "multiply", layer.opacity);
        compositeCanvas(layer.canvas, this.compositeCtx, 0, 0, layer.blendMode, layer.opacity);
      }

      // Final draw to target
      ctx.drawImage(this.compositeCanvas, 0, 0);
    }

    clearAll() {
      for (const layer of this.layers) {
        layer.clear();
      }
    }

    resize(width, height) {
      this.width = width;
      this.height = height;
      for (const layer of this.layers) {
        layer.resize(width, height);
      }
      this.compositeCanvas.width = width;
      this.compositeCanvas.height = height;
    }
  }

  // =========================================================================================
  // History Manager (Undo/Redo)
  // =========================================================================================

  class Command {
    constructor(doFn, undoFn, label = "Unnamed Command") {
      this.doFn = doFn;
      this.undoFn = undoFn;
      this.label = label;
    }

    do() {
      this.doFn && this.doFn();
    }

    undo() {
      this.undoFn && this.undoFn();
    }
  }

  class HistoryManager {
    constructor(limit = 100) {
      this.undoStack = [];
      this.redoStack = [];
      this.limit = limit;
    }

    push(command) {
      this.undoStack.push(command);
      if (this.undoStack.length > this.limit) {
        this.undoStack.shift();
      }
      this.redoStack.length = 0;
      command.do();
    }

    undo() {
      const cmd = this.undoStack.pop();
      if (!cmd) return;
      cmd.undo();
      this.redoStack.push(cmd);
    }

    redo() {
      const cmd = this.redoStack.pop();
      if (!cmd) return;
      cmd.do();
      this.undoStack.push(cmd);
    }

    clear() {
      this.undoStack.length = 0;
      this.redoStack.length = 0;
    }
  }

  // =========================================================================================
  // Brush Engine and Brushes
  // =========================================================================================

  /**
   * BrushContext is provided to each brush stamp operation.
   */
  class BrushContext {
    constructor(layer, colorPalette) {
      this.layer = layer;
      this.colorPalette = colorPalette;
      this.ctx = layer.ctx;
      this.depthCtx = layer.depthCtx;
      this.width = layer.canvas.width;
      this.height = layer.canvas.height;
      this.tmpCanvas = createOffscreenCanvas(this.width, this.height); // used by some brushes
      this.tmpCtx = this.tmpCanvas.getContext("2d");
    }
  }

  /**
   * Base Brush class.
   */
  class Brush {
    constructor(options = {}) {
      this.name = options.name || "Brush";
      this.size = clamp(options.size ?? 20, 1, 1024);
      this.opacity = clamp(options.opacity ?? 1.0, 0, 1);
      this.flow = clamp(options.flow ?? 0.8, 0, 1);
      this.hardness = clamp(options.hardness ?? 0.7, 0, 1);
      this.spacing = clamp(options.spacing ?? 0.1, 0.01, 2.0); // spacing relative to size
      this.scatter = clamp(options.scatter ?? 0, 0, 1); // random offset ratio
      this.angle = options.angle ?? 0; // degrees
      this.roundness = clamp(options.roundness ?? 1.0, 0.1, 1.0); // ellipse ratio
      this.texture = options.texture || null; // Image/Canvas for texture brush
      this.pattern = options.pattern || null; // CanvasPattern
      this.depthStrength = clamp(options.depthStrength ?? 0.0, 0, 1.0); // pseudo-relief amount
      this.smudge = clamp(options.smudge ?? 0.0, 0, 1.0); // smudge amount [0-1]
      this.enableTilt = options.enableTilt ?? false;
      this.enablePressure = options.enablePressure ?? true;
      this.blendMode = options.blendMode || "source-over";
      this.softEdge = options.softEdge ?? true;
      this.airflow = clamp(options.airflow ?? 0.0, 0, 1.0); // for airbrush
      this.maxStampPerMove = clamp(options.maxStampPerMove ?? 64, 1, 256);
      this.id = uuid();
    }

    /**
     * Prepare brush before a stroke.
     */
    beginStroke(ctx, color) {
      this._lastSmudgeSample = null;
      ctx.save();
      ctx.globalCompositeOperation = this.blendMode;
      ctx.globalAlpha = this.opacity;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
    }

    /**
     * End brush stroke.
     */
    endStroke(ctx) {
      ctx.restore();
    }

    /**
     * Compute stamp spacing in pixels based on brush size and spacing factor.
     */
    getSpacingPx(pressure = 1.0) {
      const size = this.enablePressure ? this.size * pressure : this.size;
      return Math.max(1, size * this.spacing);
    }

    /**
     * Draw a single stamp. Override in subclasses for custom behavior.
     */
    stamp(bctx, x, y, pressure = 1.0, tilt = { x: 0, y: 0 }) {
      const ctx = bctx.ctx;
      const depthCtx = bctx.depthCtx;
      const size = this.enablePressure ? this.size * pressure : this.size;
      const radiusX = (size / 2) * this.roundness;
      const radiusY = size / 2;
      const angleRad = deg2rad(this.angle);

      const sx = x + (Math.random() - 0.5) * size * this.scatter;
      const sy = y + (Math.random() - 0.5) * size * this.scatter;

      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(angleRad);
      ctx.globalAlpha = this.opacity * this.flow;

      // Soft edge via radial gradient
      if (this.softEdge) {
        const gradCanvas = createOffscreenCanvas(size, size);
        const gctx = gradCanvas.getContext("2d");
        const grad = gctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
        grad.addColorStop(0, "rgba(255,255,255,1)");
        grad.addColorStop(this.hardness, "rgba(255,255,255,1)");
        grad.addColorStop(1, "rgba(255,255,255,0)");
        gctx.fillStyle = grad;
        gctx.beginPath();
        gctx.ellipse(size / 2, size / 2, radiusX, radiusY, 0, 0, Math.PI * 2);
        gctx.fill();
        ctx.globalCompositeOperation = this.blendMode;
        ctx.drawImage(gradCanvas, -size / 2, -size / 2);
      } else {
        ctx.beginPath();
        ctx.ellipse(0, 0, radiusX, radiusY, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // Depth/relief: simple lightened stamp into depth canvas for shading
      if (this.depthStrength > 0) {
        depthCtx.save();
        depthCtx.translate(sx, sy);
        depthCtx.rotate(angleRad);
        const dAlpha = clamp(this.depthStrength * 0.6, 0, 1);
        depthCtx.globalAlpha = dAlpha;
        depthCtx.fillStyle = "rgba(255,255,255,1)";
        depthCtx.beginPath();
        depthCtx.ellipse(0, 0, radiusX, radiusY, 0, 0, Math.PI * 2);
        depthCtx.fill();
        depthCtx.restore();
      }

      ctx.restore();
    }
  }

  /**
   * Round brush - default soft round brush.
   */
  class RoundBrush extends Brush {
    constructor(options = {}) {
      super({ name: "Round Brush", ...options });
    }
  }

  /**
   * Flat brush - elliptical stamp with angle.
   */
  class FlatBrush extends Brush {
    constructor(options = {}) {
      super({ name: "Flat Brush", roundness: clamp(options.roundness ?? 0.4, 0.1, 1.0), ...options });
    }
  }

  /**
   * Calligraphy brush - oriented flat brush with greater hardness.
   */
  class CalligraphyBrush extends Brush {
    constructor(options = {}) {
      super({
        name: "Calligraphy Brush",
        roundness: clamp(options.roundness ?? 0.3, 0.1, 1.0),
        hardness: clamp(options.hardness ?? 0.9, 0, 1),
        ...options,
      });
    }
  }

  /**
   * Airbrush - continuous spraying with airflow parameter and random jitter.
   */
  class Airbrush extends Brush {
    constructor(options = {}) {
      super({
        name: "Airbrush",
        softEdge: true,
        spacing: clamp(options.spacing ?? 0.02, 0.01, 0.2),
        airflow: clamp(options.airflow ?? 0.3, 0, 1),
        scatter: clamp(options.scatter ?? 0.2, 0, 1),
        ...options,
      });
      this._lastSprayTime = 0;
    }

    stamp(bctx, x, y, pressure = 1.0) {
      const ctx = bctx.ctx;
      const depthCtx = bctx.depthCtx;
      const size = this.enablePressure ? this.size * pressure : this.size;
      const count = Math.round(5 + size * this.airflow * 2);
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = randFloat(0, size * 0.5);
        const sx = x + Math.cos(angle) * radius;
        const sy = y + Math.sin(angle) * radius;
        ctx.save();
        ctx.globalAlpha = this.opacity * this.flow * randFloat(0.2, 1);
        ctx.beginPath();
        ctx.arc(sx, sy, randFloat(0.5, size * 0.12), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        if (this.depthStrength > 0) {
          depthCtx.save();
          depthCtx.globalAlpha = clamp(this.depthStrength * randFloat(0.2, 0.8), 0, 1);
          depthCtx.beginPath();
          depthCtx.arc(sx, sy, randFloat(0.2, size * 0.1), 0, Math.PI * 2);
          depthCtx.fillStyle = "rgba(255,255,255,1)";
          depthCtx.fill();
          depthCtx.restore();
        }
      }
    }
  }

  /**
   * Texture brush - stamps a texture/image with masking via softness/hardness.
   */
  class TextureBrush extends Brush {
    constructor(options = {}) {
      super({ name: "Texture Brush", ...options });
      assert(options.texture, "TextureBrush requires a texture image/canvas");
      this.texture = options.texture;
      this._patternCanvas = createOffscreenCanvas(this.texture.width, this.texture.height);
      const pctx = this._patternCanvas.getContext("2d");
      pctx.drawImage(this.texture, 0, 0);
      this.pattern = pctx.createPattern(this._patternCanvas, "repeat");
    }

    stamp(bctx, x, y, pressure = 1.0) {
      const ctx = bctx.ctx;
      const depthCtx = bctx.depthCtx;
      const size = this.enablePressure ? this.size * pressure : this.size;
      const radius = size / 2;
      const sx = x + (Math.random() - 0.5) * size * this.scatter;
      const sy = y + (Math.random() - 0.5) * size * this.scatter;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(deg2rad(this.angle));
      ctx.globalAlpha = this.opacity * this.flow;
      ctx.fillStyle = this.pattern;
      ctx.beginPath();
      ctx.arc(0, 0, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      if (this.depthStrength > 0) {
        depthCtx.save();
        depthCtx.translate(sx, sy);
        depthCtx.rotate(deg2rad(this.angle));
        depthCtx.globalAlpha = clamp(this.depthStrength * 0.5, 0, 1);
        depthCtx.fillStyle = "rgba(255,255,255,1)";
        depthCtx.beginPath();
        depthCtx.arc(0, 0, radius, 0, Math.PI * 2);
        depthCtx.fill();
        depthCtx.restore();
      }
    }
  }

  /**
   * Smudge brush - samples underlying pixels and drags them.
   */
  class SmudgeBrush extends Brush {
    constructor(options = {}) {
      super({
        name: "Smudge Brush",
        smudge: clamp(options.smudge ?? 0.7, 0, 1),
        opacity: clamp(options.opacity ?? 0.9, 0, 1),
        spacing: clamp(options.spacing ?? 0.05, 0.01, 2.0),
        ...options,
      });
    }

    beginStroke(ctx, color) {
      super.beginStroke(ctx, color);
      this._lastSampleColor = null;
    }

    sampleColorAt(bctx, x, y) {
      const { ctx } = bctx;
      const sx = clamp(x | 0, 0, bctx.width - 1);
      const sy = clamp(y | 0, 0, bctx.height - 1);
      const data = ctx.getImageData(sx, sy, 1, 1).data;
      return { r: data[0], g: data[1], b: data[2], a: data[3] / 255 };
    }

    stamp(bctx, x, y, pressure = 1.0) {
      const ctx = bctx.ctx;
      const size = this.enablePressure ? this.size * pressure : this.size;
      const radius = size / 2;
      // Sample initial color if not set
      if (!this._lastSampleColor) {
        this._lastSampleColor = this.sampleColorAt(bctx, x, y);
      } else {
        // Blend towards current sample based on smudge amount
        const curSample = this.sampleColorAt(bctx, x, y);
        const s = this.smudge;
        this._lastSampleColor = {
          r: lerp(this._lastSampleColor.r, curSample.r, s),
          g: lerp(this._lastSampleColor.g, curSample.g, s),
          b: lerp(this._lastSampleColor.b, curSample.b, s),
          a: lerp(this._lastSampleColor.a, curSample.a, s),
        };
      }

      const col = rgba(
        this._lastSampleColor.r,
        this._lastSampleColor.g,
        this._lastSampleColor.b,
        clamp(this._lastSampleColor.a * this.opacity, 0, 1)
      );

      ctx.save();
      ctx.globalCompositeOperation = this.blendMode;
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  /**
   * Scatter brush - scatters small decals or shapes with random rotation.
   */
  class ScatterBrush extends Brush {
    constructor(options = {}) {
      super({
        name: "Scatter Brush",
        spacing: clamp(options.spacing ?? 0.2, 0.05, 2.0),
        scatter: clamp(options.scatter ?? 0.5, 0, 1.0),
        ...options,
      });
      this.decals = options.decals || []; // array of canvas/images
    }

    stamp(bctx, x, y, pressure = 1.0) {
      const ctx = bctx.ctx;
      const size = this.enablePressure ? this.size * pressure : this.size;
      const count = Math.round(1 + size * 0.05);
      for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const radius = randFloat(0, size * this.scatter);
        const sx = x + Math.cos(angle) * radius;
        const sy = y + Math.sin(angle) * radius;

        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(angle);
        ctx.globalAlpha = clamp(this.opacity * this.flow * randFloat(0.5, 1), 0, 1);
        if (this.decals.length) {
          const decal = this.decals[i % this.decals.length];
          const scale = randFloat(0.4, 1.2);
          ctx.drawImage(decal, -size * scale * 0.25, -size * scale * 0.25, size * scale * 0.5, size * scale * 0.5);
        } else {
          // Fallback decal shape
          ctx.beginPath();
          ctx.moveTo(0, -size * 0.15);
          ctx.lineTo(size * 0.15, 0);
          ctx.lineTo(0, size * 0.15);
          ctx.lineTo(-size * 0.15, 0);
          ctx.closePath();
          ctx.fill();
        }
        ctx.restore();
      }
    }
  }

  /**
   * BrushEngine: manages brush lifecycle, stroke buffering, and stamping.
   */
  class BrushEngine {
    constructor(layerManager, colorPalette) {
      this.layerManager = layerManager;
      this.colorPalette = colorPalette;
      this.activeBrush = new RoundBrush();
      this.currentColor = "#000000";
      this.smoothing = "catmull"; // "none" | "bezier" | "catmull"
      this.smoothingResolution = 16;
      this.maxPointsBuffer = 1024;
      this._points = [];
      this._isStroking = false;
      this._lastStampPos = null;
      this._lastStampTime = 0;
      this._pressureFallback = 0.5;
      this._tilt = { x: 0, y: 0 };
    }

    setBrush(brush) {
      assert(brush, "Brush cannot be null");
      this.activeBrush = brush;
    }

    setColor(color) {
      this.currentColor = color;
    }

    setSmoothing(type = "catmull", resolution = 16) {
      this.smoothing = type;
      this.smoothingResolution = resolution;
    }

    beginStroke(x, y, pressure = 0.5, tilt = { x: 0, y: 0 }) {
      const layer = this.layerManager.getActiveLayer();
      assert(layer, "No active layer to draw on");
      const bctx = new BrushContext(layer, this.colorPalette);
      this._bctx = bctx;
      this._isStroking = true;
      this._points.length = 0;
      this._lastStampPos = { x, y };
      this._lastStampTime = performance.now();
      this._tilt = tilt || { x: 0, y: 0 };

      const colorRGBA = this.colorPalette.toRGBA(this.currentColor);
      this.activeBrush.beginStroke(bctx.ctx, colorRGBA);

      // Initial stamp
      this._stampPoint(x, y, pressure);
    }

    moveStroke(x, y, pressure = 0.5, tilt = { x: 0, y: 0 }) {
      if (!this._isStroking) return;
      this._tilt = tilt || { x: 0, y: 0 };

      this._points.push({ x, y, pressure });
      if (this._points.length > this.maxPointsBuffer) {
        this._points.shift();
      }

      const spacing = this.activeBrush.getSpacingPx(pressure);
      const lastPos = this._lastStampPos || { x, y };
      const dist = distance(lastPos.x, lastPos.y, x, y);
      if (dist >= spacing) {
        const smoothed = this._smoothPoints(this._points);
        let stamps = 0;
        for (let i = 0; i < smoothed.length; i++) {
          const p = smoothed[i];
          const d = distance(lastPos.x, lastPos.y, p.x, p.y);
          if (d >= spacing) {
            this._stampPoint(p.x, p.y, p.pressure);
            this._lastStampPos = { x: p.x, y: p.y };
            stamps++;
            if (stamps >= this.activeBrush.maxStampPerMove) break;
          }
        }
      }

      // Airbrush continuous effect
      if (this.activeBrush instanceof Airbrush) {
        const now = performance.now();
        const dt = now - this._lastStampTime;
        // Spray more on slower movement
        const speed = dist / Math.max(dt, 1);
        const extra = Math.max(0, (this.activeBrush.airflow * 10 - speed) | 0);
        for (let i = 0; i < extra; i++) {
          this._stampPoint(x + randFloat(-1, 1), y + randFloat(-1, 1), pressure);
        }
        this._lastStampTime = now;
      }
    }

    endStroke() {
      if (!this._isStroking) return;
      this._isStroking = false;
      this.activeBrush.endStroke(this._bctx.ctx);
      this._points.length = 0;

      // Recompute shading from depth for active layer
      this._applyDepthShading();
    }

    _stampPoint(x, y, pressure = 0.5) {
      const tilt = this._tilt || { x: 0, y: 0 };
      this.activeBrush.stamp(this._bctx, x, y, pressure, tilt);
    }

    _smoothPoints(points) {
      if (this.smoothing === "none" || points.length < 3) return points.slice();
      if (this.smoothing === "bezier") {
        const out = [];
        for (let i = 0; i < points.length - 2; i++) {
          const p = quadraticBezier(points[i], points[i + 1], points[i + 2], this.smoothingResolution);
          out.push(...p);
        }
        return out;
      }
      // catmull
      return catmullRomSpline(points, 0.5, this.smoothingResolution);
    }

    _applyDepthShading() {
      const layer = this.layerManager.getActiveLayer();
      const ctx = layer.ctx;
      const depthCtx = layer.depthCtx;

      // Extract height map from depthCanvas
      const hdata = depthCtx.getImageData(0, 0, layer.canvas.width, layer.canvas.height);
      const normalMap = heightToNormalMap(hdata, 1.2);
      const shadeMap = shadeFromNormalMap(normalMap, { x: 0.3, y: -0.6, z: 0.8 }, 0.25);

      // Blur shading slightly for softer relief
      const blurredShade = gaussianBlurImageData(shadeMap, 2);
      drawImageData(depthCtx, blurredShade, 0, 0, 0.5);
    }
  }

  // =========================================================================================
  // Input Controller (Pointer Events)
  // =========================================================================================

  class InputController {
    constructor(canvas, brushEngine) {
      this.canvas = canvas;
      this.brushEngine = brushEngine;
      this._bound = false;
      this._pressureSim = 0.5;
      this._isDown = false;

      this._onPointerDown = this._onPointerDown.bind(this);
      this._onPointerMove = this._onPointerMove.bind(this);
      this._onPointerUp = this._onPointerUp.bind(this);
      this._onContextMenu = (e) => e.preventDefault();
    }

    bind() {
      if (this._bound) return;
      this.canvas.addEventListener("pointerdown", this._onPointerDown);
      this.canvas.addEventListener("pointermove", this._onPointerMove);
      this.canvas.addEventListener("pointerup", this._onPointerUp);
      this.canvas.addEventListener("pointerleave", this._onPointerUp);
      this.canvas.addEventListener("contextmenu", this._onContextMenu);
      this._bound = true;
    }

    unbind() {
      if (!this._bound) return;
      this.canvas.removeEventListener("pointerdown", this._onPointerDown);
      this.canvas.removeEventListener("pointermove", this._onPointerMove);
      this.canvas.removeEventListener("pointerup", this._onPointerUp);
      this.canvas.removeEventListener("pointerleave", this._onPointerUp);
      this.canvas.removeEventListener("contextmenu", this._onContextMenu);
      this._bound = false;
    }

    _posFromEvent(e) {
      const rect = this.canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) * (this.canvas.width / rect.width);
      const y = (e.clientY - rect.top) * (this.canvas.height / rect.height);
      return { x, y };
    }

    _onPointerDown(e) {
      if (e.button !== 0) return;
      this.canvas.setPointerCapture && this.canvas.setPointerCapture(e.pointerId);
      this._isDown = true;
      const pos = this._posFromEvent(e);
      const pressure = this._getPressure(e);
      const tilt = { x: e.tiltX || 0, y: e.tiltY || 0 };
      this.brushEngine.beginStroke(pos.x, pos.y, pressure, tilt);
    }

    _onPointerMove(e) {
      if (!this._isDown) return;
      const pos = this._posFromEvent(e);
      const pressure = this._getPressure(e);
      const tilt = { x: e.tiltX || 0, y: e.tiltY || 0 };
      this.brushEngine.moveStroke(pos.x, pos.y, pressure, tilt);
    }

    _onPointerUp(e) {
      if (!this._isDown) return;
      this._isDown = false;
      this.brushEngine.endStroke();
    }

    _getPressure(e) {
      // Use actual pointer pressure if available; otherwise simulate based on speed/acceleration
      if (typeof e.pressure === "number" && e.pressure > 0) {
        return clamp(e.pressure, 0.05, 1.0);
      }
      // simple fallback
      this._pressureSim = clamp(this._pressureSim + (Math.random() - 0.5) * 0.1, 0.1, 1.0);
      return this._pressureSim;
    }
  }

  // =========================================================================================
  // Painter: Orchestrates everything
  // =========================================================================================

  class Painter {
    constructor(canvas, options = {}) {
      assert(canvas && canvas.getContext, "Painter requires a valid canvas element");
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.width = canvas.width;
      this.height = canvas.height;

      this.palette = new ColorPalette(options.customColors || []);
      this.layers = new LayerManager(this.width, this.height);
      this.history = new HistoryManager(options.historyLimit || 200);
      this.brushEngine = new BrushEngine(this.layers, this.palette);
      this.input = new InputController(canvas, this.brushEngine);

      // Default setup
      this.layers.addLayer({ name: "Background", visible: true, isReference: true });
      this.layers.addLayer({ name: "Paint Layer", visible: true });

      this.brushEngine.setColor("#000000");
      this.brushEngine.setBrush(new RoundBrush({ size: 24, opacity: 0.9, spacing: 0.1, depthStrength: 0.2 }));

      this.render(); // initial
      this.input.bind();

      // Optional grid or reference
      this._gridEnabled = options.gridEnabled ?? false;
      this._gridSize = options.gridSize ?? 32;
    }

    setBrushByName(name, options = {}) {
      let brush;
      switch (name.toLowerCase()) {
        case "round":
          brush = new RoundBrush(options);
          break;
        case "flat":
          brush = new FlatBrush(options);
          break;
        case "calligraphy":
          brush = new CalligraphyBrush(options);
          break;
        case "airbrush":
          brush = new Airbrush(options);
          break;
        case "texture":
          brush = new TextureBrush(options);
          break;
        case "smudge":
          brush = new SmudgeBrush(options);
          break;
        case "scatter":
          brush = new ScatterBrush(options);
          break;
        default:
          brush = new RoundBrush(options);
      }
      this.brushEngine.setBrush(brush);
    }

    setColor(color) {
      this.brushEngine.setColor(color);
    }

    setBlendMode(mode) {
      const layer = this.layers.getActiveLayer();
      if (!layer) return;
      const previous = layer.blendMode;
      const cmd = new Command(
        () => (layer.blendMode = mode),
        () => (layer.blendMode = previous),
        `Set Blend Mode: ${mode}`
      );
      this.history.push(cmd);
      this.render();
    }

    addLayer(name = "New Layer") {
      const layer = this.layers.addLayer({ name, visible: true });
      const index = this.layers.layers.length - 1;
      const cmd = new Command(
        () => this.layers.setActiveLayer(index),
        () => {
          this.layers.removeLayer(index);
          this.layers.setActiveLayer(this.layers.layers.length - 1);
        },
        `Add Layer: ${name}`
      );
      this.history.push(cmd);
      this.render();
      return layer;
    }

    removeActiveLayer() {
      const index = this.layers.activeLayerIndex;
      if (index < 0) return;
      const layerSnapshot = this._snapshotLayer(index);
      const cmd = new Command(
        () => this.layers.removeLayer(index),
        () => this._restoreLayerSnapshot(index, layerSnapshot),
        `Remove Layer`
      );
      this.history.push(cmd);
      this.render();
    }

    _snapshotLayer(index) {
      const l = this.layers.layers[index];
      const c = createOffscreenCanvas(l.canvas.width, l.canvas.height);
      const dc = createOffscreenCanvas(l.depthCanvas.width, l.depthCanvas.height);
      c.getContext("2d").drawImage(l.canvas, 0, 0);
      dc.getContext("2d").drawImage(l.depthCanvas, 0, 0);
      return {
        index,
        properties: {
          name: l.name,
          visible: l.visible,
          opacity: l.opacity,
          blendMode: l.blendMode,
          locked: l.locked,
          isReference: l.isReference,
          meta: deepClone(l.meta),
        },
        canvas: c,
        depthCanvas: dc,
      };
    }

    _restoreLayerSnapshot(index, snapshot) {
      const l = new Layer(this.width, this.height, snapshot.properties);
      l.ctx.drawImage(snapshot.canvas, 0, 0);
      l.depthCtx.drawImage(snapshot.depthCanvas, 0, 0);
      this.layers.insertLayer(index, snapshot.properties);
      this.layers.layers[index] = l;
    }

    setActiveLayer(index) {
      const previous = this.layers.activeLayerIndex;
      const cmd = new Command(
        () => this.layers.setActiveLayer(index),
        () => this.layers.setActiveLayer(previous),
        `Set Active Layer: ${index}`
      );
      this.history.push(cmd);
      this.render();
    }

    toggleLayerVisibility(index, visible = null) {
      const l = this.layers.layers[index];
      const prev = l.visible;
      const next = visible == null ? !prev : !!visible;
      const cmd = new Command(
        () => (l.visible = next),
        () => (l.visible = prev),
        `Toggle Visibility: Layer ${index}`
      );
      this.history.push(cmd);
      this.render();
    }

    clearActiveLayer() {
      const index = this.layers.activeLayerIndex;
      if (index < 0) return;
      const snapshot = this._snapshotLayer(index);
      const cmd = new Command(
        () => this.layers.layers[index].clear(),
        () => this._restoreLayerSnapshot(index, snapshot),
        `Clear Layer ${index}`
      );
      this.history.push(cmd);
      this.render();
    }

    undo() {
      this.history.undo();
      this.render();
    }

    redo() {
      this.history.redo();
      this.render();
    }

    exportComposite(type = "image/png", quality = 0.92) {
      // Composite to internal canvas first
      this.layers.compositeTo(this.ctx);
      return this.canvas.toDataURL(type, quality);
    }

    exportLayer(index, type = "image/png", quality = 0.92) {
      const l = this.layers.layers[index];
      const tmp = createOffscreenCanvas(l.canvas.width, l.canvas.height);
      const tctx = tmp.getContext("2d");
      compositeCanvas(l.depthCanvas, tctx, 0, 0, "multiply", l.opacity);
      compositeCanvas(l.canvas, tctx, 0, 0, l.blendMode, l.opacity);
      return tmp.toDataURL(type, quality);
    }

    render() {
      const { width, height } = this.canvas;
      this.ctx.save();
      this.ctx.clearRect(0, 0, width, height);

      // Background fill
      this.ctx.fillStyle = "#ffffff";
      this.ctx.fillRect(0, 0, width, height);

      // Optional grid overlay
      if (this._gridEnabled) {
        this._drawGrid(this._gridSize, "#eee");
      }

      // Composite layers
      this.layers.compositeTo(this.ctx);
      this.ctx.restore();
    }

    _drawGrid(size = 32, color = "#eee") {
      const { width, height } = this.canvas;
      this.ctx.save();
      this.ctx.strokeStyle = color;
      this.ctx.lineWidth = 1;
      for (let x = 0; x < width; x += size) {
        this.ctx.beginPath();
        this.ctx.moveTo(x, 0);
        this.ctx.lineTo(x, height);
        this.ctx.stroke();
      }
      for (let y = 0; y < height; y += size) {
        this.ctx.beginPath();
        this.ctx.moveTo(0, y);
        this.ctx.lineTo(width, y);
        this.ctx.stroke();
      }
      this.ctx.restore();
    }

    // Convenience setters for brush parameters
    setBrushSize(size) {
      this.brushEngine.activeBrush.size = clamp(size, 1, 1024);
    }
    setBrushOpacity(opacity) {
      this.brushEngine.activeBrush.opacity = clamp(opacity, 0, 1);
    }
    setBrushFlow(flow) {
      this.brushEngine.activeBrush.flow = clamp(flow, 0, 1);
    }
    setBrushHardness(hardness) {
      this.brushEngine.activeBrush.hardness = clamp(hardness, 0, 1);
    }
    setBrushSpacing(spacing) {
      this.brushEngine.activeBrush.spacing = clamp(spacing, 0.01, 2.0);
    }
    setBrushScatter(scatter) {
      this.brushEngine.activeBrush.scatter = clamp(scatter, 0, 1);
    }
    setBrushAngle(angle) {
      this.brushEngine.activeBrush.angle = angle;
    }
    setBrushRoundness(roundness) {
      this.brushEngine.activeBrush.roundness = clamp(roundness, 0.1, 1.0);
    }
    setBrushDepthStrength(strength) {
      this.brushEngine.activeBrush.depthStrength = clamp(strength, 0, 1.0);
    }
    setBrushSmudge(amount) {
      this.brushEngine.activeBrush.smudge = clamp(amount, 0, 1.0);
    }
    setBrushBlendMode(mode) {
      this.brushEngine.activeBrush.blendMode = mode;
    }
    setBrushAirflow(flow) {
      this.brushEngine.activeBrush.airflow = clamp(flow, 0, 1.0);
    }
    setSmoothing(mode = "catmull", resolution = 16) {
      this.brushEngine.setSmoothing(mode, resolution);
    }

    // Load texture into TextureBrush
    async loadTextureBrushFromURL(url, options = {}) {
      const img = await this._loadImage(url);
      const brush = new TextureBrush({ texture: img, ...options });
      this.setBrush(brush);
    }

    setBrush(brush) {
      this.brushEngine.setBrush(brush);
    }

    async _loadImage(url) {
      return new Promise((resolve, reject) => {
        const img = new Image();
        img.crossOrigin = "anonymous";
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = url;
      });
    }
  }

  // =========================================================================================
  // Pattern and Texture Utilities
  // =========================================================================================

  /**
   * Generate a procedural paper texture for background or texture brushes.
   */
  function generatePaperTexture(width, height, options = {}) {
    const canvas = createOffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    const baseColor = options.baseColor || "#f7f4ea";
    const noiseIntensity = clamp(options.noiseIntensity ?? 0.08, 0, 1);
    const grainSize = clamp(options.grainSize ?? 1, 1, 4);

    // Base fill
    ctx.fillStyle = baseColor;
    ctx.fillRect(0, 0, width, height);

    // Grain
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = (y * width + x) * 4;
        const noise = (Math.random() - 0.5) * 255 * noiseIntensity;
        data[idx] = clamp(data[idx] + noise, 0, 255);
        data[idx + 1] = clamp(data[idx + 1] + noise, 0, 255);
        data[idx + 2] = clamp(data[idx + 2] + noise, 0, 255);
      }
    }
    ctx.putImageData(imageData, 0, 0);

    // Light vignette
    const grad = ctx.createRadialGradient(width / 2, height / 2, width * 0.1, width / 2, height / 2, Math.max(width, height) * 0.6);
    grad.addColorStop(0, "rgba(255,255,255,0)");
    grad.addColorStop(1, "rgba(0,0,0,0.06)");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);

    return canvas;
  }

  /**
   * Create a tiling pattern from a source canvas/image.
   */
  function createPatternFromSource(source, repetition = "repeat") {
    const canvas = createOffscreenCanvas(source.width, source.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(source, 0, 0);
    return ctx.createPattern(canvas, repetition);
  }

  // =========================================================================================
  // Blend Modes Helpers
  // =========================================================================================

  const BLEND_MODES = [
    "source-over",
    "destination-over",
    "multiply",
    "screen",
    "overlay",
    "darken",
    "lighten",
    "color-dodge",
    "color-burn",
    "hard-light",
    "soft-light",
    "difference",
    "exclusion",
    "hue",
    "saturation",
    "color",
    "luminosity",
  ];

  // =========================================================================================
  // Public API
  // =========================================================================================

  const API = {
    Painter,
    BrushEngine,
    LayerManager,
    Layer,
    HistoryManager,
    RoundBrush,
    FlatBrush,
    CalligraphyBrush,
    Airbrush,
    TextureBrush,
    SmudgeBrush,
    ScatterBrush,
    ColorPalette,
    BLEND_MODES,
    generatePaperTexture,
    createPatternFromSource,
    utils: {
      clamp,
      lerp,
      distance,
      rgbToHex,
      hexToRgb,
      hsvToRgb,
      hslToRgb,
      rgbToHsl,
      rgba,
      gaussianBlurImageData,
      heightToNormalMap,
      shadeFromNormalMap,
      createOffscreenCanvas,
      catmullRomSpline,
      quadraticBezier,
    },
  };

  // =========================================================================================
  // Example usage docs in comments:
  // =========================================================================================

  /**
   * Example:
   * 
   * const canvas = document.getElementById('paint');
   * const painter = new PaintMasterJS.Painter(canvas, { gridEnabled: true, gridSize: 24 });
   * 
   * // Switch brush
   * painter.setBrushByName('calligraphy', { size: 30, angle: 25, spacing: 0.08, depthStrength: 0.25 });
   * 
   * // Change color
   * painter.setColor('#3366ff');
   * 
   * // Add a new layer
   * painter.addLayer('Highlights');
   * 
   * // Export composite
   * const dataURL = painter.exportComposite('image/png');
   * 
   * // Use a texture brush
   * const texture = PaintMasterJS.generatePaperTexture(256, 256, { noiseIntensity: 0.12 });
   * painter.setBrush(new PaintMasterJS.TextureBrush({ texture, size: 48, spacing: 0.2 }));
   * 
   * // Blend modes
   * painter.setBlendMode('multiply');
   */

  // Return the public API
  return API;
});
