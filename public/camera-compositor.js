export const BACKGROUND = '#202530';

// Only high-confidence person pixels are retained. Uncertain edges stay covered.
export function personAlpha(confidence) {
  if (!Number.isFinite(confidence)) return 0;
  const value = Math.min(1, Math.max(0, (confidence - 0.7) / 0.25));
  return Math.round(255 * value * value * (3 - 2 * value));
}

export function createCompositor(width, height) {
  const output = new OffscreenCanvas(width, height);
  const context = output.getContext('2d');
  const maskCanvas = new OffscreenCanvas(width, height);
  const maskContext = maskCanvas.getContext('2d');
  return {
    compose(frame, mask) {
      const values = mask.getAsFloat32Array();
      if (values.length !== mask.width * mask.height) throw new Error('Invalid person mask');
      maskCanvas.width = mask.width;
      maskCanvas.height = mask.height;
      const pixels = maskContext.createImageData(mask.width, mask.height);
      for (let i = 0; i < values.length; i++) pixels.data[i * 4 + 3] = personAlpha(values[i]);
      maskContext.putImageData(pixels, 0, 0);
      context.globalCompositeOperation = 'source-over';
      context.clearRect(0, 0, width, height);
      context.drawImage(frame, 0, 0, width, height);
      context.globalCompositeOperation = 'destination-in';
      context.drawImage(maskCanvas, 0, 0, width, height);
      context.globalCompositeOperation = 'destination-over';
      context.fillStyle = BACKGROUND;
      context.fillRect(0, 0, width, height);
      return output.transferToImageBitmap();
    },
  };
}
