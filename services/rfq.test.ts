import { describe, expect, it } from 'vitest';
import type { Project, RfqRequest } from '../types';
import { buildRfqEml } from './rfq';

const project = {
  id: 'p1',
  name: 'Progetto di prova',
  description: '',
  createdBy: 'mario@example.com\r\nBcc: evil@example.com',
} as unknown as Project;

const request = {
  id: 'r1',
  companyName: 'Ditta di prova',
  status: 'da_inviare',
  pec: 'pec@example.com\r\nBcc: evil@example.com',
} as unknown as RfqRequest;

describe('buildRfqEml', () => {
  it('non consente di iniettare intestazioni email', () => {
    const eml = buildRfqEml(project, request);
    const headers = eml.split('\r\n\r\n')[0].split('\r\n');

    expect(headers.some(line => /^Bcc:/i.test(line))).toBe(false);
    expect(headers.find(line => line.startsWith('To:'))).toContain('pec@example.com');
    expect(headers.find(line => line.startsWith('From:'))).toContain('mario@example.com');
  });
});
