export type CalendarInviteEvent = {
  uid: string;
  title: string;
  description: string;
  date: string;
  reminderDaysBefore?: number | number[];
  url?: string | null;
};

export type CalendarInviteDelivery = "shared" | "downloaded" | "cancelled";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validIsoDate(value: string) {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function nextIsoDate(value: string) {
  const date = new Date(`${value}T12:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function compactDate(value: string) {
  return value.replaceAll("-", "");
}

function compactTimestamp(value: Date) {
  return value
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

function escapeIcsText(value: string) {
  return value
    .replace(
      /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g,
      "",
    )
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n|\u2028|\u2029/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

function safeUid(value: string) {
  const cleaned = value
    .normalize("NFKD")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160);
  return cleaned || "renewal";
}

function foldIcsLine(value: string) {
  const encoder = new TextEncoder();
  let lineBytes = 0;
  let folded = "";
  for (const character of value) {
    const characterBytes = encoder.encode(character).length;
    if (lineBytes + characterBytes > 73) {
      folded += "\r\n ";
      lineBytes = 1;
    }
    folded += character;
    lineBytes += characterBytes;
  }
  return folded;
}

function safeReminderDays(value?: number | number[]) {
  if (value === undefined) return [7];
  const values = Array.isArray(value) ? value : [value];
  return [
    ...new Set(
      values
        .filter((days) => Number.isFinite(days))
        .map((days) => Math.max(0, Math.min(365, Math.round(days)))),
    ),
  ].sort((left, right) => right - left);
}

function safeHttpsUrl(value?: string | null) {
  if (!value || /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/u.test(value)) {
    return null;
  }

  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

export function buildCalendarInvite(
  events: CalendarInviteEvent[],
  generatedAt = new Date(),
) {
  if (!events.length) {
    throw new Error("At least one calendar event is required.");
  }
  if (Number.isNaN(generatedAt.getTime())) {
    throw new Error("The calendar generation time is invalid.");
  }

  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Vigilo//Compliance Check-ins//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Vigilo check-ins",
  ];

  for (const event of events) {
    if (!validIsoDate(event.date)) {
      throw new Error("A calendar event has an invalid date.");
    }
    const reminderDays = safeReminderDays(event.reminderDaysBefore);
    const eventUrl = safeHttpsUrl(event.url);
    lines.push(
      "BEGIN:VEVENT",
      `UID:${safeUid(event.uid)}@license-lantern`,
      `DTSTAMP:${compactTimestamp(generatedAt)}`,
      `DTSTART;VALUE=DATE:${compactDate(event.date)}`,
      `DTEND;VALUE=DATE:${compactDate(nextIsoDate(event.date))}`,
      `SUMMARY:${escapeIcsText(event.title)}`,
      `DESCRIPTION:${escapeIcsText(event.description)}`,
    );
    if (eventUrl) {
      lines.push(`URL:${eventUrl}`);
    }
    lines.push("STATUS:CONFIRMED", "TRANSP:TRANSPARENT");
    for (const days of reminderDays) {
      lines.push(
        "BEGIN:VALARM",
        days === 0 ? "TRIGGER:-PT0M" : `TRIGGER:-P${days}D`,
        "ACTION:DISPLAY",
        `DESCRIPTION:${escapeIcsText(event.title)}`,
        "END:VALARM",
      );
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");

  return `${lines.map(foldIcsLine).join("\r\n")}\r\n`;
}

function safeFileName(value: string) {
  const base = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${base || "vigilo-check-ins"}.ics`;
}

export async function offerCalendarInvite(
  events: CalendarInviteEvent[],
  fileName = "vigilo-check-ins",
): Promise<CalendarInviteDelivery> {
  const contents = buildCalendarInvite(events);
  const resolvedFileName = safeFileName(fileName);
  const blob = new Blob([contents], { type: "text/calendar;charset=utf-8" });
  const file = new File([blob], resolvedFileName, {
    type: "text/calendar;charset=utf-8",
  });

  let canShareFile = false;
  if (
    typeof navigator.share === "function" &&
    typeof navigator.canShare === "function"
  ) {
    try {
      canShareFile = navigator.canShare({ files: [file] });
    } catch {
      canShareFile = false;
    }
  }

  if (canShareFile) {
    try {
      await navigator.share({
        title: "Vigilo calendar check-ins",
        text: "Add these credential and compliance check-ins to your calendar.",
        files: [file],
      });
      return "shared";
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        return "cancelled";
      }
      // Some installed browsers advertise file sharing but reject calendar
      // files at delivery time. Fall through to a normal download.
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = resolvedFileName;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
  return "downloaded";
}
