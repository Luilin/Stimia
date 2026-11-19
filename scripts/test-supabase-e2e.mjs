import { createClient } from '@supabase/supabase-js';

/**
 * Test E2E autenticati su un progetto Supabase di staging.
 *
 * Richiede:
 *   SUPABASE_URL
 *   SUPABASE_ANON_KEY
 *   SUPABASE_SERVICE_ROLE_KEY
 *
 * Non viene eseguito automaticamente se mancano le variabili.
 * Per sicurezza, sul progetto di produzione richiede E2E_ALLOW_PRODUCTION=1.
 */

const url = (process.env.SUPABASE_URL || '').trim();
const anonKey = (process.env.SUPABASE_ANON_KEY || '').trim();
const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

if (!url || !anonKey || !serviceKey) {
  console.log('SKIP E2E: imposta SUPABASE_URL, SUPABASE_ANON_KEY e SUPABASE_SERVICE_ROLE_KEY.');
  process.exit(0);
}

if (url.includes('kywyqxbncqmwhroyucdq') && process.env.E2E_ALLOW_PRODUCTION !== '1') {
  console.log('SKIP E2E: progetto di produzione. Imposta E2E_ALLOW_PRODUCTION=1 per eseguire.');
  process.exit(0);
}

const service = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const ownerClient = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const dittaClient = createClient(url, anonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const suffix = Date.now().toString(36);
const password = `E2e-${suffix}-Aa1!`;
const ownerEmail = `e2e-owner-${suffix}@example.com`;
const dittaEmail = `e2e-ditta-${suffix}@example.com`;
const projectId = `e2e-${suffix}`;

let ownerId = null;
let dittaId = null;
let storagePath = null;
let passed = 0;
let failed = 0;

function ok(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name} ${detail}`);
  }
}

async function createUser(email) {
  const { data, error } = await service.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error || !data.user) throw new Error(`Creazione utente ${email}: ${error?.message}`);
  return data.user.id;
}

async function signIn(client, email) {
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) throw new Error(`Login ${email}: ${error?.message}`);
  return data.session.user.id;
}

const rootWbs = {
  id: 'root',
  code: '',
  name: 'Root',
  level: 0,
  items: [],
  children: [
    {
      id: 'cat',
      code: '1',
      name: 'Categoria',
      level: 1,
      children: [],
      items: [
        {
          id: 'item1',
          code: '1.1',
          description: 'Voce base',
          uom: 'm',
          qty: 2,
          price: 100,
          amount: 200,
          activeDimensions: { length: false, area: false, height: false, weight: false },
        },
      ],
    },
  ],
};

const offerTree = {
  ...rootWbs,
  children: [
    {
      ...rootWbs.children[0],
      items: [
        {
          ...rootWbs.children[0].items[0],
          code: 'HACK',
          description: 'MODIFICATA',
          uom: 'kg',
          qty: 999,
          offerPrice: 777,
          offerNotes: 'offerta e2e',
        },
        {
          id: 'ditta-new',
          code: 'D.1',
          description: 'Variante ditta',
          uom: 'cad',
          qty: 1,
          price: 999,
          amount: 999,
          offerPrice: 999,
          isContractorItem: true,
          activeDimensions: { length: false, area: false, height: false, weight: false },
        },
      ],
    },
  ],
};

try {
  ownerId = await createUser(ownerEmail);
  dittaId = await createUser(dittaEmail);
  await signIn(ownerClient, ownerEmail);
  await signIn(dittaClient, dittaEmail);

  const payload = {
    id: projectId,
    name: 'E2E',
    description: '',
    lastModified: Date.now(),
    createdBy: ownerEmail,
    userId: ownerId,
    rootWBS: rootWbs,
    sals: [],
    priceBooks: [],
  };

  const created = await ownerClient.from('projects').insert({
    id: projectId,
    owner_id: ownerId,
    owner_email: ownerEmail,
    name: 'E2E',
    last_modified: Date.now(),
    payload,
  });
  if (created.error) throw new Error(`Creazione progetto: ${created.error.message}`);

  const member = await service.from('project_members').insert({
    project_id: projectId,
    email: dittaEmail,
    role: 'editor',
    can_write: false,
    can_edit_sal: false,
    can_edit_price_books: false,
    can_edit_offer: true,
  });
  if (member.error) throw new Error(`Creazione membro: ${member.error.message}`);

  const meta = await service
    .from('projects')
    .select('updated_at')
    .eq('id', projectId)
    .single();
  if (meta.error) throw new Error(`Lettura token: ${meta.error.message}`);
  const token = meta.data.updated_at;

  const offer = await dittaClient.rpc('save_project_offer', {
    p_project_id: projectId,
    p_offer_tree: offerTree,
    p_contractor_details: { companyName: 'Ditta E2E', vatNumber: 'IT123' },
    p_expected_updated_at: token,
  });
  ok('Ditta: RPC offerta eseguita', !offer.error, offer.error?.message || '');

  const afterOffer = await service.from('projects').select('payload').eq('id', projectId).single();
  const saved = afterOffer.data?.payload;
  const baseItem = saved?.rootWBS?.children?.[0]?.items?.find(item => item.id === 'item1');
  const addedItem = saved?.rootWBS?.children?.[0]?.items?.find(item => item.id === 'ditta-new');
  ok('Ditta: base non modificata', baseItem?.description === 'Voce base' && baseItem?.uom === 'm' && baseItem?.qty === 2 && baseItem?.price === 100);
  ok('Ditta: offerta salvata', baseItem?.offerPrice === 777 && baseItem?.offerNotes === 'offerta e2e');
  ok('Ditta: nuova voce aggiunta', addedItem?.isContractorItem === true);
  ok('Ditta: contractorDetails salvati', saved?.contractorDetails?.companyName === 'Ditta E2E');

  const stale = await dittaClient.rpc('save_project_offer', {
    p_project_id: projectId,
    p_offer_tree: offerTree,
    p_contractor_details: null,
    p_expected_updated_at: token,
  });
  ok(
    'Concorrenza: token vecchio rifiutato',
    Boolean(stale.error) && /conflitto|40001/i.test(`${stale.error?.code} ${stale.error?.message}`),
    JSON.stringify(stale.error),
  );

  const rlsUpdate = await dittaClient
    .from('projects')
    .update({ name: 'hack' })
    .eq('id', projectId)
    .select('id');
  ok('RLS: ditta non aggiorna il progetto', Boolean(rlsUpdate.error) || (rlsUpdate.data?.length || 0) === 0, JSON.stringify(rlsUpdate.error));

  storagePath = `${projectId}/attachments/e2e.txt`;
  const dittaUpload = await dittaClient.storage
    .from('stimia-files')
    .upload(storagePath, new Blob(['e2e'], { type: 'text/plain' }), { upsert: true });
  ok('Storage: ditta non carica allegati', Boolean(dittaUpload.error), dittaUpload.error?.message || '');

  const ownerUpload = await ownerClient.storage
    .from('stimia-files')
    .upload(storagePath, new Blob(['e2e'], { type: 'text/plain' }), { upsert: true });
  ok('Storage: proprietario carica allegati', !ownerUpload.error, ownerUpload.error?.message || '');

  const version = await dittaClient.from('project_versions').insert({
    id: `ver-${suffix}`,
    project_id: projectId,
    reason: 'E2E',
    hash: 'e2e',
    stats: {},
    snapshot: payload,
  });
  ok('Versioni: ditta crea una versione', !version.error, version.error?.message || '');

  const versions = await ownerClient
    .from('project_versions')
    .select('id')
    .eq('project_id', projectId);
  ok('Versioni: il proprietario le legge', !versions.error && (versions.data?.length || 0) === 1, JSON.stringify(versions.error));
} catch (error) {
  console.error('ERRORE E2E:', error);
  failed += 1;
} finally {
  try {
    if (storagePath) await service.storage.from('stimia-files').remove([storagePath]);
    await service.from('projects').delete().eq('id', projectId);
    if (ownerId) await service.auth.admin.deleteUser(ownerId);
    if (dittaId) await service.auth.admin.deleteUser(dittaId);
  } catch (cleanupError) {
    console.warn('Pulizia E2E non riuscita:', cleanupError);
  }

  console.log(`\nRISULTATO E2E: ${passed} passati, ${failed} falliti`);
  process.exitCode = failed === 0 ? 0 : 1;
}
