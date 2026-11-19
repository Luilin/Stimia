import { describe, expect, it } from 'vitest';
import type { CostItem, InvoiceSettings, Project } from '../types';
import { buildFatturaPA } from './fatturaPA';

const item: CostItem = {
  id: 'item-1',
  code: 'A.01.01',
  description: 'Voce & <test>',
  uom: 'm',
  factor: 1,
  length: 1,
  area: 1,
  height: 1,
  weight: 1,
  activeDimensions: { length: false, area: false, height: false, weight: false },
  qty: 2,
  price: 100,
  amount: 200,
};

const project = {
  id: 'project-1',
  name: 'Progetto & <Test>',
  description: '',
  lastModified: 0,
  createdBy: 'tecnico@test.it',
  rootWBS: {
    id: 'root',
    code: '',
    name: 'Root',
    level: 0,
    items: [],
    children: [
      {
        id: 'cat-1',
        code: 'A',
        name: 'Categoria',
        level: 1,
        items: [item],
        children: [],
      },
    ],
  },
  sals: [
    {
      id: 'sal-1',
      code: 'SAL 01',
      name: 'Primo SAL',
      date: Date.UTC(2026, 10, 19),
      status: 'CLOSED',
      rows: [{ costItemId: 'item-1', qty: 2 }],
    },
  ],
} as unknown as Project;

const settings: InvoiceSettings = {
  companyName: 'Impresa & Figli',
  vatNumber: 'IT12345678901',
  taxCode: '12345678901',
  address: 'Via <Roma> 1',
  postalCode: '00100',
  city: 'Roma',
  province: 'RM',
  country: 'IT',
  regimeFiscale: 'RF01',
  iban: 'IT60X0542811101000000123456',
  invoiceNumber: '1/2026',
  invoiceDate: '2026-11-19',
  invoiceType: 'TD01',
  vatPercent: 22,
  splitPayment: false,
  ritenutaPercent: 20,
  cassaPercent: 10,
  bollo: true,
  clientName: 'Cliente & Co',
  clientVatNumber: 'IT98765432109',
  clientTaxCode: '98765432109',
  clientAddress: 'Via Test 2',
  clientPostalCode: '00100',
  clientCity: 'Roma',
  clientProvince: 'RM',
  clientCodeDestinatario: 'ABC1234',
  clientPec: 'pec@example.it',
  paymentTerms: 'Bonifico 30 giorni',
};

describe('buildFatturaPA', () => {
  it('genera XML con escape e totali corretti', () => {
    const xml = buildFatturaPA(project, 'sal-1', settings);

    expect(xml).toContain('<Denominazione>Impresa &amp; Figli</Denominazione>');
    expect(xml).toContain('<Denominazione>Cliente &amp; Co</Denominazione>');
    expect(xml).toContain('Voce &amp; &lt;test&gt;');
    expect(xml).toContain('<ImportoTotaleDocumento>270.40</ImportoTotaleDocumento>');
    expect(xml).toContain('<ImponibileImporto>220.00</ImponibileImporto>');
    expect(xml).toContain('<Imposta>48.40</Imposta>');
    expect(xml).toContain('<ImportoRitenuta>44.00</ImportoRitenuta>');
    expect(xml).toContain('<ImportoBollo>2.00</ImportoBollo>');
  });

  it('rifiuta i dati obbligatori mancanti', () => {
    expect(() => buildFatturaPA(project, 'sal-1', { ...settings, companyName: '' }))
      .toThrow(/Ragione sociale cedente/i);
  });

  it('rifiuta un SAL senza righe fatturabili', () => {
    const emptyProject = {
      ...project,
      sals: [{ ...project.sals![0], rows: [] }],
    } as Project;

    expect(() => buildFatturaPA(emptyProject, 'sal-1', settings))
      .toThrow(/non contiene quantità/i);
  });
});
