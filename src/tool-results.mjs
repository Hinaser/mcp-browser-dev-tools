export function asToolResult(value) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
    ],
    structuredContent: value,
  };
}

export function asImageToolResult({ value, images }) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(value, null, 2),
      },
      ...images,
    ],
    structuredContent: value,
  };
}

export function moveScreenshotImage(screenshot, images) {
  if (typeof screenshot?.data !== "string") {
    return screenshot;
  }

  const { data, ...metadata } = screenshot;
  images.push({ type: "image", data, mimeType: screenshot.mimeType });
  return { ...metadata, image: images.length };
}
