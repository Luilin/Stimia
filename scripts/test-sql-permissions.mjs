import fs from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration = fs.readFileSync('supabase/migrations/20261118_granular_permissions.sql', 'utf8');
const db = new PGlite();

const OWNER_UID = '11111111-1111-1111-1111-111111111111';
const MEMBER_UID = '22222222-2222-2222-2222-222222222222';

let passed = 0;
let failed = 0;
const failures = [];

function ok(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    failures.push(`${name}: ${detail}`);
    console.log(`FAIL  ${name}  ${detail}`);
  }
}

async function expectError(name, sql, pattern) {
  try {
    await db.query(sql);
    ok(name, false, 'nessun errore');
  } catch (error) {
    const message = String(error?.message || error);
    ok(name, pattern.test(message), message);
  }
}

async function expectSuccess(name, sql) {
  try {
    await db.query(sql);
    ok(name, true);
  } catch (error) {
    ok(name, false, String(error?.message || error));
  }
}

async function superuser() {
  await db.exec('reset role');
  await db.exec("set test.email = ''");
  await db.exec("set test.uid = ''");
}

async function asMember(email, uid = MEMBER_UID) {
  await db.exec('reset role');
  await db.exec('set role authenticated');
  await db.exec(`set test.email = '${email}'`);
  await db.exec(`set test.uid = '${uid}'`);
}

async function asOwner() {
  await db.exec('reset role');
  await db.exec('set role authenticated');
  await db.exec("set test.email = 'owner@test.it'");
  await db.exec(`set test.uid = '${OWNER_UID}'`);
}

async function asAnon() {
  await db.exec('reset role');
  await db.exec('set role anon');
  await db.exec("set test.email = ''");
  await db.exec("set test.uid = ''");
}

async function payload() {
  const result = await db.query("select payload from public.projects where id = 'p1'");
  const value = result.rows[0]?.payload;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

async function projectName() {
  const result = await db.query("select name from public.projects where id = 'p1'");
  return result.rows[0]?.name;
}

try {
  await db.exec(`
    create role anon;
    create role authenticated;

    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('test.uid', true), '')::uuid
    $$;
    create function auth.jwt() returns jsonb language sql stable as $$
      select jsonb_build_object('email', nullif(current_setting('test.email', true), ''))
    $$;
    grant usage on schema auth to anon, authenticated;
    grant execute on function auth.uid() to anon, authenticated;
    grant execute on function auth.jwt() to anon, authenticated;

    create table public.projects (
      id text primary key,
      owner_id uuid not null,
      owner_email text,
      name text not null default '',
      last_modified bigint not null default 0,
      payload jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );

    create table public.project_members (
      project_id text not null references public.projects(id) on delete cascade,
      email text not null,
      role text not null default 'editor' check (role in ('viewer', 'editor')),
      created_at timestamptz not null default now(),
      primary key (project_id, email)
    );

    create table public.project_attachments (
      id text primary key,
      project_id text not null references public.projects(id) on delete cascade
    );

    create schema storage;
    create table storage.objects (name text, bucket_id text);
    create function storage.foldername(text) returns text[] language sql immutable as $$
      select string_to_array($1, '/')
    $$;

    create function public.touch_updated_at() returns trigger language plpgsql as $$
    begin
      new.updated_at = now();
      return new;
    end;
    $$;
    create trigger projects_touch_updated_at
      before update on public.projects
      for each row execute function public.touch_updated_at();

    create function public.prevent_project_owner_change() returns trigger language plpgsql as $$
    begin
      if new.owner_id is distinct from old.owner_id then
        raise exception 'owner_id non modificabile';
      end if;
      return new;
    end;
    $$;
    create trigger projects_prevent_owner_change
      before update on public.projects
      for each row execute function public.prevent_project_owner_change();

    alter table public.projects enable row level security;
    create policy projects_select_for_test on public.projects
      for select to authenticated
      using (
        owner_id = auth.uid()
        or exists (
          select 1 from public.project_members m
          where m.project_id = projects.id
            and lower(m.email) = lower(auth.jwt() ->> 'email')
        )
      );

    grant usage on schema public to anon, authenticated;
    grant select, update on public.projects to authenticated;
    grant select on public.project_members to authenticated;
  `);

  await db.exec(migration);

  await db.exec(`
    insert into public.projects (id, owner_id, owner_email, name, last_modified, payload)
    values (
      'p1', '${OWNER_UID}', 'owner@test.it', 'P1', 100,
      '{"name":"P1","sals":[{"id":"s1"}],"priceBooks":[{"id":"b1"}],"rootWBS":{"id":"root","items":[],"children":[]},"lastModified":100}'::jsonb
    );

    insert into public.project_members (project_id, email, role, can_write, can_edit_sal, can_edit_price_books) values
      ('p1', 'writer@test.it', 'editor', true,  false, false),
      ('p1', 'sal@test.it',    'editor', false, true,  false),
      ('p1', 'pb@test.it',     'editor', false, false, true),
      ('p1', 'viewer@test.it', 'viewer', false, false, false),
      ('p1', 'ditta@test.it',  'editor', true,  false, false);
  `);

  // --- Autorizzazione ------------------------------------------------
  for (const [email, expectedWriter, expectedPriceBooks] of [
    ['writer@test.it', true, true],
    ['sal@test.it', false, false],
    ['pb@test.it', false, true],
    ['viewer@test.it', false, false],
    ['ditta@test.it', true, true],
  ]) {
    await asMember(email);
    const writer = await db.query("select public.is_project_writer('p1') as v");
    const priceBooks = await db.query("select public.is_project_price_book_editor('p1') as v");
    ok(`is_project_writer ${email}`, writer.rows[0].v === expectedWriter, String(writer.rows[0].v));
    ok(`is_project_price_book_editor ${email}`, priceBooks.rows[0].v === expectedPriceBooks, String(priceBooks.rows[0].v));
  }

  await asMember('', '33333333-3333-3333-3333-333333333333');
  const unknownWriter = await db.query("select public.is_project_writer('p1') as v");
  ok('utente estraneo non è writer', unknownWriter.rows[0].v === false, String(unknownWriter.rows[0].v));

  await asAnon();
  await expectError(
    'anon non può eseguire is_project_writer',
    "select public.is_project_writer('p1')",
    /permission denied/i,
  );

  // --- RPC SAL/prezzari ---------------------------------------------
  await asMember('sal@test.it');
  const salSave = await db.query("select public.save_project_parts('p1', '[{\"id\":\"s2\"}]'::jsonb, null) as updated_at");
  ok('SAL-only: RPC eseguita', Boolean(salSave.rows[0].updated_at), JSON.stringify(salSave.rows[0]));
  await superuser();
  let p = await payload();
  ok('SAL-only: SAL aggiornati', JSON.stringify(p.sals) === JSON.stringify([{ id: 's2' }]), JSON.stringify(p.sals));
  ok('SAL-only: prezzari invariati', JSON.stringify(p.priceBooks) === JSON.stringify([{ id: 'b1' }]), JSON.stringify(p.priceBooks));
  ok('SAL-only: nome invariato', p.name === 'P1', String(p.name));
  ok('SAL-only: lastModified aggiornato', Number(p.lastModified) > 100, String(p.lastModified));

  await asMember('sal@test.it');
  await expectError(
    'SAL-only: non può salvare i prezzari',
    "select public.save_project_parts('p1', null, '[{\"id\":\"b2\"}]'::jsonb)",
    /Permessi insufficienti per i prezzari/i,
  );

  await asMember('pb@test.it');
  const pbSave = await db.query("select public.save_project_parts('p1', null, '[{\"id\":\"b2\"}]'::jsonb) as updated_at");
  ok('Prezzari-only: RPC eseguita', Boolean(pbSave.rows[0].updated_at), JSON.stringify(pbSave.rows[0]));
  await superuser();
  p = await payload();
  ok('Prezzari-only: prezzari aggiornati', JSON.stringify(p.priceBooks) === JSON.stringify([{ id: 'b2' }]), JSON.stringify(p.priceBooks));
  ok('Prezzari-only: SAL invariati', JSON.stringify(p.sals) === JSON.stringify([{ id: 's2' }]), JSON.stringify(p.sals));

  await asMember('pb@test.it');
  await expectError(
    'Prezzari-only: non può salvare i SAL',
    "select public.save_project_parts('p1', '[{\"id\":\"s3\"}]'::jsonb, null)",
    /Permessi insufficienti per i SAL/i,
  );

  await asMember('viewer@test.it');
  await expectError(
    'Viewer: RPC bloccata',
    "select public.save_project_parts('p1', '[{\"id\":\"s3\"}]'::jsonb, null)",
    /Permessi insufficienti per i SAL/i,
  );

  await asMember('writer@test.it');
  const writerSave = await db.query("select public.save_project_parts('p1', '[{\"id\":\"s3\"}]'::jsonb, '[{\"id\":\"b3\"}]'::jsonb) as updated_at");
  ok('Writer: RPC completa eseguita', Boolean(writerSave.rows[0].updated_at), JSON.stringify(writerSave.rows[0]));
  await superuser();
  p = await payload();
  ok('Writer: SAL aggiornati', JSON.stringify(p.sals) === JSON.stringify([{ id: 's3' }]), JSON.stringify(p.sals));
  ok('Writer: prezzari aggiornati', JSON.stringify(p.priceBooks) === JSON.stringify([{ id: 'b3' }]), JSON.stringify(p.priceBooks));

  await asOwner();
  const ownerSave = await db.query("select public.save_project_parts('p1', '[{\"id\":\"s4\"}]'::jsonb, null) as updated_at");
  ok('Owner: RPC eseguita', Boolean(ownerSave.rows[0].updated_at), JSON.stringify(ownerSave.rows[0]));

  await db.exec('reset role');
  await db.exec('set role authenticated');
  await db.exec("set test.email = 'sal@test.it'");
  await db.exec("set test.uid = ''");
  await expectError(
    'Utente autenticato senza uid: Not authenticated',
    "select public.save_project_parts('p1', '[{\"id\":\"s5\"}]'::jsonb, null)",
    /Not authenticated/i,
  );

  await asMember('writer@test.it');
  await expectError(
    'Formato SAL non valido',
    "select public.save_project_parts('p1', '{}'::jsonb, null)",
    /Formato SAL non valido/i,
  );

  // JSON null deve essere trattato come parametro assente.
  await asMember('pb@test.it');
  const nullSave = await db.query("select public.save_project_parts('p1', 'null'::jsonb, '[{\"id\":\"b4\"}]'::jsonb) as updated_at");
  ok('JSON null: RPC eseguita', Boolean(nullSave.rows[0].updated_at), JSON.stringify(nullSave.rows[0]));
  await superuser();
  p = await payload();
  ok('JSON null: SAL invariati', JSON.stringify(p.sals) === JSON.stringify([{ id: 's4' }]), JSON.stringify(p.sals));
  ok('JSON null: prezzari aggiornati', JSON.stringify(p.priceBooks) === JSON.stringify([{ id: 'b4' }]), JSON.stringify(p.priceBooks));

  // --- RLS update ----------------------------------------------------
  await superuser();
  await db.exec("update public.projects set name = 'P1' where id = 'p1'");

  await asMember('viewer@test.it');
  await db.query("update public.projects set name = 'viewer-change' where id = 'p1'");
  await superuser();
  ok('RLS: viewer non modifica il progetto', (await projectName()) === 'P1', String(await projectName()));

  await asMember('sal@test.it');
  await db.query("update public.projects set name = 'sal-change' where id = 'p1'");
  await superuser();
  ok('RLS: SAL-only non modifica il progetto', (await projectName()) === 'P1', String(await projectName()));

  await asMember('writer@test.it');
  await db.query("update public.projects set name = 'writer-change' where id = 'p1'");
  await superuser();
  ok('RLS: writer modifica il progetto', (await projectName()) === 'writer-change', String(await projectName()));

  await asOwner();
  await db.query("update public.projects set name = 'owner-change' where id = 'p1'");
  await superuser();
  ok('RLS: owner modifica il progetto', (await projectName()) === 'owner-change', String(await projectName()));

  await asMember('writer@test.it');
  await expectError(
    'RLS: writer non può cambiare proprietario',
    "update public.projects set owner_id = '44444444-4444-4444-4444-444444444444' where id = 'p1'",
    /owner_id non modificabile/i,
  );

  await asAnon();
  await expectError(
    'RLS: anon non può aggiornare',
    "update public.projects set name = 'anon-change' where id = 'p1'",
    /permission denied/i,
  );

  await superuser();
  ok('RLS: nome finale invariato dopo i tentativi', (await projectName()) === 'owner-change', String(await projectName()));

  // --- Allegati e Storage --------------------------------------------
  await superuser();
  await db.exec(`
    alter table public.project_attachments enable row level security;
    grant select, insert, update, delete on public.project_attachments to authenticated;
    alter table storage.objects enable row level security;
    grant select, insert, update, delete on storage.objects to authenticated;
    grant usage on schema storage to authenticated;
    grant execute on function storage.foldername(text) to authenticated;
  `);

  await asMember('writer@test.it');
  await expectSuccess('Allegati: writer può inserire', "insert into public.project_attachments(id, project_id) values ('att-w', 'p1')");
  await expectSuccess('Storage: writer può caricare allegati', "insert into storage.objects(name, bucket_id) values ('p1/attachments/att-w', 'stimia-files')");
  await expectSuccess('Storage: writer può caricare prezzari', "insert into storage.objects(name, bucket_id) values ('p1/price-books/writer.json', 'stimia-files')");

  await asMember('sal@test.it');
  await expectError('Allegati: SAL-only non può inserire', "insert into public.project_attachments(id, project_id) values ('att-sal', 'p1')", /row-level security/i);
  await expectError('Storage: SAL-only non può caricare prezzari', "insert into storage.objects(name, bucket_id) values ('p1/price-books/sal.json', 'stimia-files')", /row-level security/i);

  await asMember('pb@test.it');
  await expectSuccess('Storage: pricebook-only può caricare prezzari', "insert into storage.objects(name, bucket_id) values ('p1/price-books/pb.json', 'stimia-files')");
  await expectError('Storage: pricebook-only non può caricare allegati', "insert into storage.objects(name, bucket_id) values ('p1/attachments/pb', 'stimia-files')", /row-level security/i);

  await asMember('viewer@test.it');
  await expectError('Allegati: viewer non può inserire', "insert into public.project_attachments(id, project_id) values ('att-viewer', 'p1')", /row-level security/i);
  await expectError('Storage: viewer non può caricare', "insert into storage.objects(name, bucket_id) values ('p1/attachments/viewer', 'stimia-files')", /row-level security/i);

  await asAnon();
  await expectError('Storage: anon non può caricare', "insert into storage.objects(name, bucket_id) values ('p1/attachments/anon', 'stimia-files')", /permission denied/i);

  // --- Verifica finale con lo script SQL read-only -------------------
  await superuser();
  await db.exec(`
    alter table public.project_members enable row level security;
    create policy members_select_for_test on public.project_members
      for select to authenticated using (true);
  `);

  const verification = await db.query(fs.readFileSync('supabase/verify_security.sql', 'utf8'));
  for (const row of verification.rows) {
    ok(`Verifica: ${row.controllo}`, row.risultato === 'PASS', String(row.risultato));
  }

  // La verifica deve accorgersi se viene reintrodotta la vecchia policy errata.
  await superuser();
  await db.exec(`
    drop policy stimia_files_insert on storage.objects;
    create policy stimia_files_insert on storage.objects
      for insert to authenticated
      with check (
        bucket_id = 'stimia-files'
        and (storage.foldername(name))[2] = 'attachments'
        and exists (
          select 1 from public.projects p
          where p.id = (storage.foldername(name))[1]
            and (p.owner_id = auth.uid() or public.is_project_writer(p.id))
        )
      );
  `);
  const buggyVerification = await db.query(fs.readFileSync('supabase/verify_security.sql', 'utf8'));
  const storageRow = buggyVerification.rows.find(row => row.controllo === 'Policy Storage usa il percorso corretto');
  ok('Verifica: rileva la policy Storage errata', storageRow?.risultato === 'FAIL', String(storageRow?.risultato));
} catch (error) {
  console.error('ERRORE FATALE:', error);
  failed += 1;
  failures.push(String(error));
} finally {
  await db.close();
  console.log(`\nRISULTATO: ${passed} passati, ${failed} falliti`);
  if (failures.length) console.log('FALLIMENTI:', failures.join(' | '));
  process.exitCode = failed === 0 ? 0 : 1;
}
