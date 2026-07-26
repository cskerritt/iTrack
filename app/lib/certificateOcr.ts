export type CertificateFieldSuggestions = {
  title?: string;
  provider?: string;
  completionDate?: string;
  credits?: number;
};

export type CertificateOcrProgress = {
  label: string;
  progress: number;
};

export type CertificateOcrResult = {
  suggestions: CertificateFieldSuggestions;
  confidence: number;
  recognizedTextLength: number;
};

const DATE_FRAGMENT =
  String.raw`(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}[-/.]\d{1,2}[-/.]\d{4}|(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:st|nd|rd|th)?[,]?\s+\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)[,]?\s+\d{4})`;

const MONTHS = new Map<string, number>(
  [
    ["jan", 1],
    ["january", 1],
    ["feb", 2],
    ["february", 2],
    ["mar", 3],
    ["march", 3],
    ["apr", 4],
    ["april", 4],
    ["may", 5],
    ["jun", 6],
    ["june", 6],
    ["jul", 7],
    ["july", 7],
    ["aug", 8],
    ["august", 8],
    ["sep", 9],
    ["september", 9],
    ["oct", 10],
    ["october", 10],
    ["nov", 11],
    ["november", 11],
    ["dec", 12],
    ["december", 12],
  ] as const,
);

function cleanOcrLine(value: string) {
  return value
    .replace(/[ \t]+/g, " ")
    .replace(/^[|•·*]+\s*/, "")
    .trim();
}

function cleanSuggestion(value: string, maximumLength: number) {
  const cleaned = value
    .replace(/\s+/g, " ")
    .replace(/^[\s:–—"'“”]+|[\s:–—"'“”]+$/g, "")
    .trim();
  if (cleaned.length < 3 || cleaned.length > maximumLength) return undefined;
  return cleaned;
}

function validIsoDate(year: number, month: number, day: number) {
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1) {
    return undefined;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(
    2,
    "0",
  )}-${String(day).padStart(2, "0")}`;
}

function parseDate(value: string) {
  const cleaned = value
    .replace(/(\d)(?:st|nd|rd|th)\b/gi, "$1")
    .replace(/,/g, "")
    .trim();

  let match = cleaned.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (match) {
    return validIsoDate(Number(match[1]), Number(match[2]), Number(match[3]));
  }

  match = cleaned.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (match) {
    return validIsoDate(Number(match[3]), Number(match[1]), Number(match[2]));
  }

  match = cleaned.match(/^([A-Za-z]+)\s+(\d{1,2})\s+(\d{4})$/);
  if (match) {
    const month = MONTHS.get(match[1].toLowerCase());
    return month
      ? validIsoDate(Number(match[3]), month, Number(match[2]))
      : undefined;
  }

  match = cleaned.match(/^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})$/);
  if (match) {
    const month = MONTHS.get(match[2].toLowerCase());
    return month
      ? validIsoDate(Number(match[3]), month, Number(match[1]))
      : undefined;
  }

  return undefined;
}

function firstLineMatch(lines: string[], patterns: RegExp[]) {
  for (const pattern of patterns) {
    for (const line of lines) {
      const match = line.match(pattern);
      if (match?.[1]) return match[1];
    }
  }
  return undefined;
}

function extractTitle(lines: string[], flatText: string) {
  const labeled = firstLineMatch(lines, [
    /^(?:course|program|activity|session|webinar|seminar|conference|training)\s+(?:title|name)\s*[:\-–—]\s*(.+)$/i,
    /^(?:course|program|activity|session|webinar|seminar|conference|training)\s*[:\-–—]\s*(.+)$/i,
  ]);
  const cleanLabeled = labeled ? cleanSuggestion(labeled, 140) : undefined;
  if (cleanLabeled) return cleanLabeled;

  const completedPattern = new RegExp(
    String.raw`\bhas\s+(?:successfully\s+)?completed\s+(?:the\s+)?(?:course|program|training|webinar|session)?\s*[:\-–—]?\s*["“]?(.{4,140}?)["”]?\s+on\s+${DATE_FRAGMENT}`,
    "i",
  );
  const completed = flatText.match(completedPattern)?.[1];
  return completed ? cleanSuggestion(completed, 140) : undefined;
}

function extractProvider(lines: string[]) {
  const provider = firstLineMatch(lines, [
    /^(?:provider|sponsor|organization|organizer|issuer)\s*[:\-–—]\s*(.+)$/i,
    /^(?:issued|presented|provided|sponsored)\s+by\s*[:\-–—]?\s*(.+)$/i,
  ]);
  return provider ? cleanSuggestion(provider, 100) : undefined;
}

function extractCompletionDate(flatText: string) {
  const labeledDatePattern = new RegExp(
    String.raw`\b(?:completion\s+date|date\s+(?:of\s+)?completion|date\s+completed|completed\s+on|awarded\s+on|issued\s+on|course\s+date)\s*[:\-–—]?\s*(${DATE_FRAGMENT})`,
    "i",
  );
  const completedSentencePattern = new RegExp(
    String.raw`\bhas\s+(?:successfully\s+)?completed\b.{3,180}?\bon\s+(${DATE_FRAGMENT})`,
    "i",
  );
  const value =
    flatText.match(labeledDatePattern)?.[1] ??
    flatText.match(completedSentencePattern)?.[1];
  return value ? parseDate(value) : undefined;
}

function extractCredits(lines: string[], flatText: string) {
  const unit =
    String.raw`(?:continuing\s+education\s+(?:units?|credits?)|contact\s+hours?|credit\s+hours?|ceu(?:s)?|pdu(?:s)?|cme\s+credits?|cle\s+credits?|credits?)`;
  const patterns = [
    new RegExp(
      String.raw`\b${unit}\s*(?:earned|awarded|completed)?\s*[:\-–—]\s*(\d+(?:[.,]\d{1,2})?)\b`,
      "i",
    ),
    new RegExp(
      String.raw`\b(?:earned|awarded|completed)\s+(\d+(?:[.,]\d{1,2})?)\s+${unit}\b`,
      "i",
    ),
    new RegExp(
      String.raw`\b(\d+(?:[.,]\d{1,2})?)\s+${unit}\b`,
      "i",
    ),
  ];
  const raw = firstLineMatch(lines, patterns) ?? firstLineMatch([flatText], patterns);
  if (!raw) return undefined;
  const credits = Number(raw.replace(",", "."));
  if (!Number.isFinite(credits) || credits <= 0 || credits > 1000) {
    return undefined;
  }
  return credits;
}

export function extractCertificateSuggestions(
  rawText: string,
): CertificateFieldSuggestions {
  const lines = rawText
    .split(/\r?\n/)
    .map(cleanOcrLine)
    .filter(Boolean);
  const flatText = lines.join(" ");
  if (!flatText) return {};

  return {
    title: extractTitle(lines, flatText),
    provider: extractProvider(lines),
    completionDate: extractCompletionDate(flatText),
    credits: extractCredits(lines, flatText),
  };
}

function progressDetails(status: string, progress: number): CertificateOcrProgress {
  const safeProgress = Math.max(0, Math.min(1, progress || 0));
  if (status.includes("core")) {
    return {
      label: "Preparing the on-device reader",
      progress: 0.05 + safeProgress * 0.2,
    };
  }
  if (status.includes("language")) {
    return {
      label: "Loading the private English model",
      progress: 0.25 + safeProgress * 0.25,
    };
  }
  if (status.includes("recognizing")) {
    return {
      label: "Reading the certificate on this device",
      progress: 0.58 + safeProgress * 0.42,
    };
  }
  return {
    label: "Starting the on-device reader",
    progress: 0.5 + safeProgress * 0.08,
  };
}

async function prepareImageForOcr(file: File) {
  if (typeof createImageBitmap !== "function") return file;

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    const longestSide = Math.max(bitmap.width, bitmap.height);
    if (longestSide <= 2600) return file;

    const scale = 2600 / longestSide;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d", { alpha: false });
    if (!context) return file;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    const resized = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.94),
    );
    return resized ?? file;
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}

export async function scanCertificateImage(
  file: File,
  onProgress?: (progress: CertificateOcrProgress) => void,
): Promise<CertificateOcrResult> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
    throw new Error("This file type cannot be read on this device.");
  }
  if (
    typeof window === "undefined" ||
    typeof Worker === "undefined" ||
    typeof WebAssembly === "undefined"
  ) {
    throw new Error("On-device text recognition is not supported here.");
  }

  onProgress?.({ label: "Preparing the image on this device", progress: 0.02 });
  const image = await prepareImageForOcr(file);
  const { createWorker, OEM } = await import("tesseract.js");
  const assetRoot = new URL("/ocr/", window.location.origin);
  const worker = await createWorker("eng", OEM.LSTM_ONLY, {
    workerPath: new URL("worker.min.js", assetRoot).href,
    corePath: new URL("core", assetRoot).href,
    langPath: new URL("lang", assetRoot).href.replace(/\/$/, ""),
    workerBlobURL: false,
    gzip: true,
    legacyCore: false,
    legacyLang: false,
    logger: (message) =>
      onProgress?.(progressDetails(message.status, message.progress)),
  });

  try {
    const result = await worker.recognize(image);
    const text = result.data.text ?? "";
    onProgress?.({ label: "Scan complete", progress: 1 });
    return {
      suggestions: extractCertificateSuggestions(text),
      confidence: Number(result.data.confidence || 0),
      recognizedTextLength: text.trim().length,
    };
  } finally {
    await worker.terminate();
  }
}
