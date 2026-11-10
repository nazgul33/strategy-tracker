export interface Holiday { date: string; en: string; ko: string }
export interface EarlyClose { date: string; et: string }

export interface YearData {
  holidays: Holiday[];
  earlyCloses: EarlyClose[];
}

export const NYSE_YEARS: Record<string, YearData> = {
  '2025': {
    holidays: [
      { date: '2025-01-01', en: "New Year's Day", ko: '신년' },
      { date: '2025-01-09', en: 'Day of Mourning (Jimmy Carter)', ko: '국가 애도의 날' },
      { date: '2025-01-20', en: 'Martin Luther King Jr. Day', ko: '마틴 루터 킹 데이' },
      { date: '2025-02-17', en: "Presidents' Day", ko: '대통령의 날' },
      { date: '2025-04-18', en: 'Good Friday', ko: '성 금요일' },
      { date: '2025-05-26', en: 'Memorial Day', ko: '메모리얼 데이' },
      { date: '2025-06-19', en: 'Juneteenth', ko: '준틴스' },
      { date: '2025-07-04', en: 'Independence Day', ko: '독립기념일' },
      { date: '2025-09-01', en: 'Labor Day', ko: '노동절' },
      { date: '2025-11-27', en: 'Thanksgiving', ko: '추수감사절' },
      { date: '2025-12-25', en: 'Christmas', ko: '크리스마스' },
    ],
    earlyCloses: [
      { date: '2025-07-03', et: '13:00' },
      { date: '2025-11-28', et: '13:00' },
      { date: '2025-12-24', et: '13:00' },
    ],
  },
  '2026': {
    holidays: [
      { date: '2026-01-01', en: "New Year's Day", ko: '신년' },
      { date: '2026-01-19', en: 'Martin Luther King Jr. Day', ko: '마틴 루터 킹 데이' },
      { date: '2026-02-16', en: "Presidents' Day", ko: '대통령의 날' },
      { date: '2026-04-03', en: 'Good Friday', ko: '성 금요일' },
      { date: '2026-05-25', en: 'Memorial Day', ko: '메모리얼 데이' },
      { date: '2026-06-19', en: 'Juneteenth', ko: '준틴스' },
      { date: '2026-07-03', en: 'Independence Day (Observed)', ko: '독립기념일' },
      { date: '2026-09-07', en: 'Labor Day', ko: '노동절' },
      { date: '2026-11-26', en: 'Thanksgiving', ko: '추수감사절' },
      { date: '2026-12-25', en: 'Christmas', ko: '크리스마스' },
    ],
    earlyCloses: [
      { date: '2026-11-27', et: '13:00' },
      { date: '2026-12-24', et: '13:00' },
    ],
  },
  '2027': {
    holidays: [
      { date: '2027-01-01', en: "New Year's Day", ko: '신년' },
      { date: '2027-01-18', en: 'Martin Luther King Jr. Day', ko: '마틴 루터 킹 데이' },
      { date: '2027-02-15', en: "Presidents' Day", ko: '대통령의 날' },
      { date: '2027-03-26', en: 'Good Friday', ko: '성 금요일' },
      { date: '2027-05-31', en: 'Memorial Day', ko: '메모리얼 데이' },
      { date: '2027-06-18', en: 'Juneteenth (Observed)', ko: '준틴스' },
      { date: '2027-07-05', en: 'Independence Day (Observed)', ko: '독립기념일' },
      { date: '2027-09-06', en: 'Labor Day', ko: '노동절' },
      { date: '2027-11-25', en: 'Thanksgiving', ko: '추수감사절' },
      { date: '2027-12-24', en: 'Christmas (Observed)', ko: '크리스마스' },
    ],
    earlyCloses: [
      { date: '2027-11-26', et: '13:00' },
    ],
  },
};
