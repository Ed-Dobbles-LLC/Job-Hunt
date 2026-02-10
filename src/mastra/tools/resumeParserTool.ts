import mammoth from "mammoth";

/**
 * Extracts raw text from a resume file buffer.
 * Supports PDF, DOCX, and plain text formats.
 */
export async function parseResumeBuffer(
  buffer: Buffer,
  fileName: string,
): Promise<{ rawText: string; format: string }> {
  const ext = fileName.split(".").pop()?.toLowerCase() || "";

  if (ext === "pdf") {
    const pdfParse = (await import("pdf-parse")).default;
    const data = await pdfParse(buffer);
    return { rawText: data.text, format: "pdf" };
  }

  if (ext === "docx" || ext === "doc") {
    const result = await mammoth.extractRawText({ buffer });
    return { rawText: result.value, format: "docx" };
  }

  // Default: treat as plain text
  return { rawText: buffer.toString("utf-8"), format: "txt" };
}
