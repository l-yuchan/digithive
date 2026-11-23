export type ExtractionResult =
  | { readonly status: "extracted"; readonly text: string; readonly truncated: boolean }
  | { readonly status: "unsupported" }
  | { readonly status: "failed"; readonly errorCode: string };

const MAX_TEXT_CHARS = 200_000;

function decode(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

/**
 * Text extraction is best effort and never runs uploaded code or HTML. A file
 * that cannot be read is reported as `failed` or `unsupported`, never stored as
 * an empty successful extraction.
 */
export async function extractText(bytes: Uint8Array, mime: string): Promise<ExtractionResult> {
  if (mime === "text/plain" || mime === "text/markdown") {
    const text = decode(bytes);
    return { status: "extracted", text: text.slice(0, MAX_TEXT_CHARS), truncated: text.length > MAX_TEXT_CHARS };
  }
  if (mime === "application/pdf") {
    try {
      const { extractText: pdfText, getDocumentProxy } = await import("unpdf");
      const document = await getDocumentProxy(new Uint8Array(bytes));
      const result = await pdfText(document, { mergePages: true });
      const text = (Array.isArray(result.text) ? result.text.join("\n") : result.text).slice(0, MAX_TEXT_CHARS);
      if (text.trim() === "") return { status: "failed", errorCode: "no_text_layer" };
      return { status: "extracted", text, truncated: text.length === MAX_TEXT_CHARS };
    } catch (error) {
      if (error instanceof Error) return { status: "failed", errorCode: "pdf_unreadable" };
      throw error;
    }
  }
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) });
      const text = result.value.slice(0, MAX_TEXT_CHARS);
      if (text.trim() === "") return { status: "failed", errorCode: "no_text_layer" };
      return { status: "extracted", text, truncated: text.length === MAX_TEXT_CHARS };
    } catch (error) {
      if (error instanceof Error) return { status: "failed", errorCode: "docx_unreadable" };
      throw error;
    }
  }
  return { status: "unsupported" };
}
