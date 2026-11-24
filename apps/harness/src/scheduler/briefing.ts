export const TIMEZONE = "Asia/Seoul";

/** Briefing slots in local hours; 07:30 and 21:00 by default. */
export const BRIEFING_SLOTS: readonly { hour: number; minute: number }[] = [
  { hour: 7, minute: 30 },
  { hour: 21, minute: 0 },
];
