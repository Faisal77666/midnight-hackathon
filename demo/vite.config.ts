import { Buffer } from 'node:buffer';
import { resolve } from 'node:path';
import nodemailer from 'nodemailer';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import { createMidnightGateway } from './midnight-gateway.js';

type ApiConfig = {
  groqApiKey?: string;
  smtpHost?: string;
  smtpPort?: string;
  smtpSecure?: string;
  smtpUser?: string;
  smtpAppPassword?: string;
  smtpFromEmail?: string;
  smtpToEmail?: string;
  publicUrl?: string;
};

const midnightGateway = createMidnightGateway();

function json(response: { writeHead: Function; end: Function }, status: number, body: object) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function requestBody(request: AsyncIterable<unknown>) {
  let body = '';
  for await (const chunk of request) body += chunk;
  return JSON.parse(body) as Record<string, string>;
}

function requestOrigin(request: { headers: Record<string, string | string[] | undefined> }, publicUrl?: string) {
  if (publicUrl) return publicUrl.replace(/\/$/, '');
  const host = request.headers.host;
  return `http://${typeof host === 'string' ? host : 'localhost:5173'}`;
}

function escapePdf(value: string) {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function lockedStatementPdf(accountHolder: string, verificationUrl?: string) {
  const lines = [
    'First National Bank',
    `Account holder: ${accountHolder}`,
    '',
    'STATEMENT LOCKED',
    'Open the verification link below and prove ownership',
    'with Midnight to view your balance and transactions.',
    ...(verificationUrl ? ['', 'Verify and unlock:', verificationUrl] : []),
  ];
  return pdfFromLines(lines, verificationUrl);
}

function unlockedStatementPdf(statement: string) {
  return pdfFromLines(['First National Bank', 'VERIFIED STATEMENT — UNLOCKED AFTER PROOF', '', ...statement.split('\n')]);
}

function pdfFromLines(lines: string[], verificationUrl?: string) {
  const content = ['BT', '/F1 22 Tf', '72 720 Td', `(${escapePdf(lines[0])}) Tj`, '/F1 14 Tf', '0 -38 Td', ...lines.slice(1).flatMap((line) => [`(${escapePdf(line)}) Tj`, '0 -24 Td']), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R${verificationUrl ? ' /Annots [6 0 R]' : ''} >>`,
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...(verificationUrl ? [`<< /Type /Annot /Subtype /Link /Rect [72 490 540 530] /Border [0 0 0] /A << /S /URI /URI (${escapePdf(verificationUrl)}) >> >>`] : []),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => { pdf += `${String(offset).padStart(10, '0')} 00000 n \n`; });
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(pdf);
}

function demoApi(config: ApiConfig): Plugin {
  return {
    name: 'demo-api',
    configureServer(server) {
      server.middlewares.use('/api/midnight/issue', async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405).end(); return; }
        try {
          const input = await requestBody(request);
          if (!input.statement || !input.identityKey || !input.bankKey || !input.nonce) {
            json(response, 400, { error: 'Statement, identity key, bank key, and nonce are required.' });
            return;
          }
          const result = await midnightGateway.issue(input as { statement: string; identityKey: string; bankKey: string; nonce: string });
          json(response, 200, {
            ...result,
            verifyUrl: `${requestOrigin(request, config.publicUrl)}/verify.html?ref=${encodeURIComponent(result.reference)}`,
          });
        } catch (error) {
          json(response, 502, { error: error instanceof Error ? error.message : 'Midnight issue transaction failed.' });
        }
      });

      server.middlewares.use('/api/midnight/prove', async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405).end(); return; }
        try {
          const input = await requestBody(request);
          if (!input.reference || !input.statement || !input.identityKey || !input.nonce) {
            json(response, 400, { error: 'Reference, statement, identity key, and nonce are required.' });
            return;
          }
          const ownershipProved = await midnightGateway.prove(input.reference, input as { statement: string; identityKey: string; nonce: string });
          json(response, 200, { ownershipProved });
        } catch (error) {
          json(response, 422, { error: error instanceof Error ? error.message : 'Midnight ownership proof failed.' });
        }
      });

      server.middlewares.use('/api/ask', async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405).end(); return; }
        if (!config.groqApiKey) { json(response, 500, { error: 'Set GROQ_API_KEY in demo/.env, then restart yarn demo.' }); return; }
        let body = '';
        for await (const chunk of request) body += chunk;
        const { statement, question } = JSON.parse(body) as { statement?: string; question?: string };
        if (!statement || !question) { json(response, 400, { error: 'Statement and question are required.' }); return; }
        const groqResponse = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.groqApiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'llama-3.3-70b-versatile', temperature: 0.2, messages: [
            { role: 'system', content: 'Answer only from the provided private statement. If the answer is not present, say so clearly.' },
            { role: 'user', content: `Private statement:\n${statement}\n\nQuestion: ${question}` },
          ] }),
        });
        const data = await groqResponse.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
        if (!groqResponse.ok) { json(response, groqResponse.status, { error: data.error?.message ?? 'Groq request failed.' }); return; }
        json(response, 200, { answer: data.choices?.[0]?.message?.content ?? 'No answer returned.' });
      });

      server.middlewares.use('/api/send-locked-statement', async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405).end(); return; }
        if (!config.smtpHost || !config.smtpUser || !config.smtpAppPassword) {
          json(response, 500, { error: 'Set SMTP_HOST, SMTP_USER, and SMTP_APP_PASSWORD in demo/.env, then restart yarn demo.' });
          return;
        }
        let body = '';
        for await (const chunk of request) body += chunk;
        const { accountHolder = 'Jane Doe', verificationUrl } = JSON.parse(body) as {
          accountHolder?: string;
          verificationUrl?: string;
        };
        const transporter = nodemailer.createTransport({
          host: config.smtpHost,
          port: Number(config.smtpPort ?? '465'),
          secure: config.smtpSecure !== 'false',
          auth: { user: config.smtpUser, pass: config.smtpAppPassword },
        });
        try {
          const result = await transporter.sendMail({
            from: config.smtpFromEmail ?? config.smtpUser,
            to: config.smtpToEmail ?? config.smtpUser,
            subject: 'Your First National Bank statement is locked',
            text: 'Your statement is attached in locked form. Open the verification link in the PDF and prove ownership to view it.',
            attachments: [{ filename: 'first-national-bank-statement.pdf', content: lockedStatementPdf(accountHolder, verificationUrl), contentType: 'application/pdf' }],
          });
          json(response, 200, { message: `Locked statement PDF sent (message id: ${result.messageId}).` });
        } catch (error) {
          json(response, 502, { error: error instanceof Error ? error.message : 'SMTP send failed.' });
        }
      });

      server.middlewares.use('/api/unlocked-statement-pdf', async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405).end(); return; }
        let body = '';
        for await (const chunk of request) body += chunk;
        const { statement } = JSON.parse(body) as { statement?: string };
        if (!statement) { json(response, 400, { error: 'An unlocked statement is required.' }); return; }
        response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="first-national-bank-unlocked-statement.pdf"' });
        response.end(unlockedStatementPdf(statement));
      });

      server.middlewares.use('/api/send-unlocked-statement', async (request, response) => {
        if (request.method !== 'POST') { response.writeHead(405).end(); return; }
        if (!config.smtpHost || !config.smtpUser || !config.smtpAppPassword) {
          json(response, 500, { error: 'Set SMTP_HOST, SMTP_USER, and SMTP_APP_PASSWORD in demo/.env, then restart yarn demo.' });
          return;
        }
        let body = '';
        for await (const chunk of request) body += chunk;
        const { statement } = JSON.parse(body) as { statement?: string };
        if (!statement) { json(response, 400, { error: 'An unlocked statement is required.' }); return; }
        const transporter = nodemailer.createTransport({
          host: config.smtpHost,
          port: Number(config.smtpPort ?? '465'),
          secure: config.smtpSecure !== 'false',
          auth: { user: config.smtpUser, pass: config.smtpAppPassword },
        });
        try {
          const result = await transporter.sendMail({
            from: config.smtpFromEmail ?? config.smtpUser,
            to: config.smtpToEmail ?? config.smtpUser,
            subject: 'Your verified First National Bank statement',
            text: 'Ownership was proved in the banking app. Your unlocked statement is attached.',
            attachments: [{ filename: 'first-national-bank-unlocked-statement.pdf', content: unlockedStatementPdf(statement), contentType: 'application/pdf' }],
          });
          json(response, 200, { message: `Unlocked statement PDF sent (message id: ${result.messageId}).` });
        } catch (error) {
          json(response, 502, { error: error instanceof Error ? error.message : 'SMTP send failed.' });
        }
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '');
  return {
    plugins: [demoApi({
      groqApiKey: env.GROQ_API_KEY,
      smtpHost: env.SMTP_HOST,
      smtpPort: env.SMTP_PORT,
      smtpSecure: env.SMTP_SECURE,
      smtpUser: env.SMTP_USER,
      smtpAppPassword: env.SMTP_APP_PASSWORD,
      smtpFromEmail: env.SMTP_FROM_EMAIL,
      smtpToEmail: env.SMTP_TO_EMAIL,
      publicUrl: env.DEMO_PUBLIC_URL,
    })],
    build: {
      rollupOptions: {
        input: {
          app: resolve(__dirname, 'index.html'),
          verify: resolve(__dirname, 'verify.html'),
        },
      },
    },
  };
});
