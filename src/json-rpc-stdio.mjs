export function encodeMessage(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${payload.length}\r\n\r\n`, "utf8"),
    payload,
  ]);
}

export class MessageBuffer {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.buffer = Buffer.concat([this.buffer, incoming]);

    const messages = [];
    while (true) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return messages;
      }

      const header = this.buffer.slice(0, headerEnd).toString("utf8");
      const match = header.match(/content-length:\s*(\d+)/i);
      if (!match) {
        this.buffer = Buffer.alloc(0);
        throw new Error("Missing Content-Length header");
      }

      const bodyLength = Number.parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;
      const bodyEnd = bodyStart + bodyLength;
      if (this.buffer.length < bodyEnd) {
        return messages;
      }

      const body = this.buffer.slice(bodyStart, bodyEnd).toString("utf8");
      this.buffer = this.buffer.slice(bodyEnd);
      messages.push(JSON.parse(body));
    }
  }
}
