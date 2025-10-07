# PaintMasterJS overview

PaintMasterJS is a comprehensive, canvas-focused painting library designed for rich brush behavior, layered composition, and pseudo-3D depth effects without requiring WebGL. It provides a modular architecture: utilities for math and color, a robust layer stack with blend modes, a brush engine with multiple brush types, pointer-based input control, undo/redo history, and exporting utilities. The implementation emphasizes extensibility and performance-aware stroke processing, blending practical techniques like Catmull–Rom smoothing, separable Gaussian blur, and simulated normal/shade maps.

---

# Architecture and main components

### Core structure
- **UMD wrapper:** Supports ES modules, CommonJS, and global window usage.
- **Public API:** Bundles classes (Painter, BrushEngine, LayerManager, brushes, etc.) and utilities.
- **Canvas-first design:** All drawing uses the 2D canvas API with offscreen canvases.

### Primary classes
- **Painter:** Orchestrates layers, brush engine, input, history, and rendering.
- **LayerManager / Layer:** Manages ordering, visibility, blending, opacity, and depth canvases.
- **BrushEngine:** Controls stroke lifecycle, smoothing, and stamping.
- **Brush variants:** Round, Flat, Calligraphy, Airbrush, Texture, Smudge, Scatter.
- **InputController:** Handles pointer events, pressure, and tilt.
- **HistoryManager:** Command-based undo/redo.

---

# Utilities and helpers

### Math utilities
- Clamp, lerp, distance, angle conversions.
- Catmull–Rom spline and quadratic Bezier smoothing.
- Random float/int, UUID generator.

### Image processing
- Gaussian blur (separable).
- Height-to-normal map conversion.
- Shading from normal maps.

### Canvas compositing
- Draw ImageData with alpha.
- Composite canvases with blend modes.

---

# Color, palette, and conversions

### Preset palette
- 100-color HSV distribution with balanced saturation/value bands.

### ColorPalette class
- Normalize colors (hex or RGB).
- Conversions: RGB⇄HSL/HSV.
- Transformations: lighten, darken, shift hue.
- Output rgba() strings.

---

# Layering, composition, and export

### Layer design
- Dual canvases: paint + depth.
- Properties: name, visibility, opacity, blend mode, metadata.
- Resizing with content preservation.

### LayerManager
- Add, insert, remove, move, set active, toggle visibility.
- Composite pipeline: background + depth + color.
- Global composite canvas for final blit.

### Exporting
- Composite export to PNG/JPEG/WebP.
- Per-layer export with depth + color.

---

# Brush engine and brushes

### BrushEngine stroke lifecycle
- Begin → Move → End.
- Buffers points, smooths, stamps.
- Applies depth shading at stroke end.

### Brush parameters
- Size, opacity, flow, hardness, spacing, angle, roundness, scatter.
- Depth strength, smudge, soft edge, airflow, max stamps.

### Brush variants
| Brush       | Edge softness | Pressure | Unique trait   | Use case             |
|-------------|---------------|----------|----------------|----------------------|
| Round       | Soft/hard     | Yes      | Gradient edge  | General painting     |
| Flat        | Medium        | Yes      | Elliptical     | Broad strokes        |
| Calligraphy | Hard          | Yes      | Angular flow   | Lettering            |
| Airbrush    | Very soft     | Partial  | Spray effect   | Atmosphere, shading  |
| Texture     | Variable      | Yes      | Pattern fill   | Textured surfaces    |
| Smudge      | Soft          | Yes      | Color sampling | Blending, smearing   |
| Scatter     | Variable      | Yes      | Decals         | Foliage, noise       |

---

# Pointer input and pressure

### InputController
- Binds pointer events.
- Maps client coords to canvas space.
- Uses native pressure or simulates fallback.
- Passes tiltX/tiltY to brushes.

---

# Undo/redo history

### Command pattern
- Command object with do/undo.
- Undo/redo stacks with limit.
- Layer snapshot/restore for destructive ops.

---

# Simulated depth and shading

### Depth accumulation
- Depth stamps mark depth canvas.
- Height map from luminance.

### Normal and shade maps
- Normals from height differences.
- Shading with directional light + ambient.
- Gaussian blur softens shading.

---

# Performance considerations

- Spacing control reduces overdraw.
- Adjustable smoothing resolution.
- Max stamp cap prevents runaway costs.
- Separable blur for efficiency.
- Depth shading applied after stroke.

---

# API surface and typical usage

### Exports
- Painter, BrushEngine, LayerManager, Layer, HistoryManager.
- Brushes: Round, Flat, Calligraphy, Airbrush, Texture, Smudge, Scatter.
- ColorPalette, BLEND_MODES.
- Utilities: clamp, lerp, rgb/hex/hsl/hsv conversions, blur, normal/shade maps.

### Quick start
```html
<canvas id="paint" width="1024" height="768"></canvas>
<script>
  const canvas = document.getElementById('paint');
  const painter = new PaintMasterJS.Painter(canvas, { gridEnabled: true, gridSize: 24 });

  painter.setBrushByName('calligraphy', { size: 30, angle: 25, spacing: 0.08, depthStrength: 0.25 });
  painter.setColor('#3366ff');
  painter.addLayer('Highlights');

  const url = painter.exportComposite('image/png');
  console.log('Exported:', url);
</script>
