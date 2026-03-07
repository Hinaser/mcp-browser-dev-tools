export const MAX_MESSAGE_BYTES = 1024 * 1024;

function findHeaderEnd(buffer) {
  const crlfHeaderEnd = buffer.indexOf("\r\n\r\n");
  if (crlfHeaderEnd !== -1) {
    return {
      headerEnd: crlfHeaderEnd,
      separatorLength: 4,
    };
  }

  const lfHeaderEnd = buffer.indexOf("\n\n");
  if (lfHeaderEnd !== -1) {
    return {
      headerEnd: lfHeaderEnd,
      separatorLength: 2,
    };
  }

  return null;
}

function findJsonMessage(buffer) {
  const text = buffer.toString("utf8");
  let start = 0;
  while (start < text.length && /\s/.test(text[start])) {
    start += 1;
  }

  if (start >= text.length) {
    return null;
  }

  const firstChar = text[start];
  if (firstChar !== "{" && firstChar !== "[") {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaping = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaping) {
        escaping = false;
        continue;
      }

      if (char === "\\") {
        escaping = true;
        continue;
      }

      if (char === '"') {
        inString = false;
      }

      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      depth += 1;
      continue;
    }

    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth < 0) {
        throw new Error("Malformed JSON message");
      }

      if (depth === 0) {
        let end = index + 1;
        while (end < text.length && /\s/.test(text[end])) {
          end += 1;
        }

        return {
          consumedBytes: Buffer.byteLength(text.slice(0, end), "utf8"),
          jsonText: text.slice(start, index + 1),
        };
      }
    }
  }

  return null;
}

export function encodeMessage(message, transportMode = "content-length") {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  if (transportMode === "json") {
    return Buffer.concat([payload, Buffer.from("\n", "utf8")]);
  }

  return Buffer.concat([
    Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8"),
    payload,
  ]);
}

export class MessageBuffer {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.transportMode = null;
  }

  push(chunk) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, incoming]);

    if (this.buffer.length > MAX_MESSAGE_BYTES) {
      this.buffer = Buffer.alloc(0);
      throw new Error("Message buffer exceeded maximum size");
    }

    const messages = [];
    while (true) {
      const headerMatch = findHeaderEnd(this.buffer);
      if (headerMatch) {
        const { headerEnd, separatorLength } = headerMatch;
        const header = this.buffer.slice(0, headerEnd).toString("utf8");
        const match = header.match(/content-length:\s*(\d+)/i);
        if (!match) {
          this.buffer = Buffer.alloc(0);
          throw new Error("Missing Content-Length header");
        }

        const bodyLength = Number.parseInt(match[1], 10);
        if (bodyLength > MAX_MESSAGE_BYTES) {
          this.buffer = Buffer.alloc(0);
          throw new Error("Message exceeded maximum size");
        }

        const bodyStart = headerEnd + separatorLength;
        const bodyEnd = bodyStart + bodyLength;
        if (this.buffer.length < bodyEnd) {
          return messages;
        }

        const body = this.buffer.slice(bodyStart, bodyEnd).toString("utf8");
        this.buffer = this.buffer.slice(bodyEnd);
        this.transportMode ??= "content-length";
        messages.push(JSON.parse(body));
        continue;
      }

      const jsonMatch = findJsonMessage(this.buffer);
      if (!jsonMatch) {
        return messages;
      }

      const { consumedBytes, jsonText } = jsonMatch;
      this.buffer = this.buffer.slice(consumedBytes);
      this.transportMode ??= "json";
      messages.push(JSON.parse(jsonText));
    }
  }
}
