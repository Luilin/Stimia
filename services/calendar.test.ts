import { describe, expect, it } from 'vitest';
import type { Project } from '../types';
import { buildIcs, googleCalendarUrl, projectDeadlines } from './calendar';

const day = (year: number, month: number, dayOfMonth: number) =>
  new Date(year, month - 1, dayOfMonth, 12, 0, 0).getTime();

const project = {
  sals: [
    { id: 'sal-1', code: 'SAL 01', name: 'Primo stato', status: 'CLOSED', date: day(2026, 1, 10) },
  ],
  offers: [
    { id: 'offer-1', companyName: 'Rossi Costruzioni', date: day(2026, 1, 1), validityDays: 30 },
  ],
  rfqRequests: [
    { id: 'rfq-1', companyName: 'Bianchi Impianti', deadline: day(2026, 2, 1) },
  ],
  suppliers: [
    {
      id: 'sup-1',
      companyName: 'Verdi Srl',
      type: 'fornitore',
      durcExpiry: day(2026, 3, 1),
    },
  ],
  variants: [
    { id: 'var-1', code: 'V01', name: 'Variante lavori', type: 'variante', date: day(2026, 4, 1) },
  ],
} as unknown as Project;

describe('projectDeadlines', () => {
  it('raccoglie SAL, offerte, richieste, fornitori e varianti', () => {
    const events = projectDeadlines(project);
    expect(events).toHaveLength(5);
    expect(events.map(event => event.source)).toEqual(
      expect.arrayContaining(['SAL', 'Offerta', 'Richiesta preventivo', 'Fornitore', 'Variante']),
    );
  });

  it('ordina gli eventi per data crescente', () => {
    const dates = projectDeadlines(project).map(event => event.date);
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
  });

  it('calcola la scadenza di un’offerta dalla validità in giorni', () => {
    const offer = projectDeadlines(project).find(event => event.source === 'Offerta');
    expect(offer?.date).toBe(day(2026, 1, 31));
  });
});

describe('buildIcs', () => {
  it('produce un calendario valido con gli eventi', () => {
    const events = projectDeadlines(project);
    const ics = buildIcs(project, events);
    expect(ics).toContain('BEGIN:VCALENDAR');
    expect(ics).toContain('END:VCALENDAR');
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(events.length);
    expect(ics).toContain('DTSTART;VALUE=DATE:20260110');
  });

  it('genera un link Google Calendar con le date', () => {
    const event = projectDeadlines(project)[0];
    const url = googleCalendarUrl(event);
    expect(url).toContain('https://calendar.google.com/calendar/render');
    expect(url).toContain('dates=');
  });
});
