import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { supabaseAdmin } from '../lib/supabase';
import { authMiddleware, type AuthEnv } from '../middleware/auth';
import { PDFDocument, StandardFonts, rgb, degrees } from 'pdf-lib';
import { env } from '../env';

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const consentRouter = new Hono<AuthEnv>();

// ---------------------------------------------------------------------------
// Agreement text template
// ---------------------------------------------------------------------------

function buildAgreementText(creatorName: string, participantName: string, contentDescription?: string): string {
  return `YONKAMANIA CONTENT CREATION CONSENT, RELEASE & VERIFICATION AGREEMENT

This Agreement is entered into by:

Creator: ${creatorName}
Participant: ${participantName}
${contentDescription ? `Content Description: ${contentDescription}\n` : ''}

1. CONSENT TO RECORDING
I voluntarily consent to being recorded, photographed, and/or appearing in digital content ("Content") created by the Creator.

2. RIGHTS & LICENSE
I grant an irrevocable, perpetual, worldwide, royalty-free license to:
- Use, reproduce, distribute, display, and monetize the Content
- Modify, edit, or adapt the Content
- Publish the Content on Yonkamania and any other platforms

3. AGE & ID VERIFICATION
I confirm that:
- I am at least 18 years of age
- I possess valid government-issued identification
- I am legally able to consent

I acknowledge that false statements may result in legal consequences.

4. CONSENT TO DISTRIBUTION (INCLUDING PAID CONTENT)
I understand the Content may be:
- Sold or monetized
- Distributed publicly or privately
- Accessed by paying users

5. NO OWNERSHIP CLAIM
I waive any rights to:
- Ownership of the Content
- Future compensation (unless separately agreed)

6. RELEASE OF LIABILITY
I release and hold harmless:
- The Creator
- Yonkamania
- Affiliates and partners

From any claims related to:
- Use or distribution of the Content
- Monetization of the Content

7. VOLUNTARY AGREEMENT
I confirm:
- I am signing willingly
- No coercion or pressure was involved

8. DIGITAL SIGNATURE AGREEMENT
I agree that:
- My electronic signature is legally binding
- This agreement is enforceable as a written contract`;
}

// ---------------------------------------------------------------------------
// PDF Generator
// ---------------------------------------------------------------------------

async function generateConsentPDF(params: {
  creatorName: string;
  participantName: string;
  contentDescription?: string;
  signatureText: string;
  signatureImageBase64?: string;
  signedAt: string;
  signerIp: string;
  signerUserAgent: string;
}): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  const timesRoman = await pdfDoc.embedFont(StandardFonts.TimesRoman);
  const timesBold = await pdfDoc.embedFont(StandardFonts.TimesRomanBold);
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 612;
  const pageHeight = 792;
  const marginLeft = 60;
  const marginRight = 60;
  const contentWidth = pageWidth - marginLeft - marginRight;

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - 60;

  const drawText = (text: string, x: number, yPos: number, size: number, font: typeof timesRoman, color = rgb(0, 0, 0)) => {
    page.drawText(text, { x, y: yPos, size, font, color });
  };

  const addPage = () => {
    page = pdfDoc.addPage([pageWidth, pageHeight]);
    y = pageHeight - 60;
  };

  const checkPageBreak = (neededHeight: number) => {
    if (y - neededHeight < 80) {
      addPage();
    }
  };

  // Header bar
  page.drawRectangle({
    x: 0,
    y: pageHeight - 80,
    width: pageWidth,
    height: 80,
    color: rgb(0.04, 0.04, 0.08),
  });

  // Yonkamania logo text
  drawText('YONKAMANIA', marginLeft, pageHeight - 45, 22, helveticaBold, rgb(1, 1, 1));
  drawText('CREATOR STUDIO', marginLeft, pageHeight - 63, 9, helvetica, rgb(0.6, 0.6, 0.7));

  // "SIGNED DOCUMENT" badge on right
  page.drawRectangle({
    x: pageWidth - marginRight - 120,
    y: pageHeight - 68,
    width: 120,
    height: 28,
    color: rgb(0.2, 0.8, 0.4),
  });
  drawText('SIGNED DOCUMENT', pageWidth - marginRight - 112, pageHeight - 55, 8, helveticaBold, rgb(0, 0.2, 0.05));

  y = pageHeight - 100;

  // Title
  checkPageBreak(40);
  drawText('CONTENT CREATION CONSENT, RELEASE &', marginLeft, y, 13, timesBold);
  y -= 18;
  drawText('VERIFICATION AGREEMENT', marginLeft, y, 13, timesBold);
  y -= 30;

  // Divider line
  page.drawLine({ start: { x: marginLeft, y }, end: { x: pageWidth - marginRight, y }, thickness: 1, color: rgb(0.7, 0.7, 0.7) });
  y -= 20;

  // Parties section
  checkPageBreak(60);
  drawText('This Agreement is entered into by:', marginLeft, y, 10, timesRoman);
  y -= 18;
  drawText('Creator:', marginLeft, y, 10, timesBold);
  drawText(params.creatorName, marginLeft + 55, y, 10, timesRoman);
  y -= 14;
  drawText('Participant:', marginLeft, y, 10, timesBold);
  drawText(params.participantName, marginLeft + 70, y, 10, timesRoman);
  if (params.contentDescription) {
    y -= 14;
    drawText('Content:', marginLeft, y, 10, timesBold);
    // Wrap long content description
    const words = params.contentDescription.split(' ');
    let line = '';
    let firstLine = true;
    for (const word of words) {
      const testLine = line ? `${line} ${word}` : word;
      if (helvetica.widthOfTextAtSize(testLine, 10) > contentWidth - 60) {
        drawText(line, marginLeft + 55, y, 10, timesRoman);
        y -= 13;
        if (!firstLine) checkPageBreak(13);
        line = word;
        firstLine = false;
      } else {
        line = testLine;
      }
    }
    if (line) drawText(line, marginLeft + 55, y, 10, timesRoman);
  }
  y -= 22;

  // Agreement body
  const agreementSections = [
    {
      title: '1. CONSENT TO RECORDING',
      body: 'I voluntarily consent to being recorded, photographed, and/or appearing in digital content ("Content") created by the Creator.',
    },
    {
      title: '2. RIGHTS & LICENSE',
      body: 'I grant an irrevocable, perpetual, worldwide, royalty-free license to: use, reproduce, distribute, display, and monetize the Content; modify, edit, or adapt the Content; and publish the Content on Yonkamania and any other platforms.',
    },
    {
      title: '3. AGE & ID VERIFICATION',
      body: 'I confirm that I am at least 18 years of age, I possess valid government-issued identification, and I am legally able to consent. I acknowledge that false statements may result in legal consequences.',
    },
    {
      title: '4. CONSENT TO DISTRIBUTION (INCLUDING PAID CONTENT)',
      body: 'I understand the Content may be sold or monetized, distributed publicly or privately, and accessed by paying users.',
    },
    {
      title: '5. NO OWNERSHIP CLAIM',
      body: 'I waive any rights to ownership of the Content and future compensation (unless separately agreed).',
    },
    {
      title: '6. RELEASE OF LIABILITY',
      body: 'I release and hold harmless the Creator, Yonkamania, and their affiliates and partners from any claims related to the use, distribution, or monetization of the Content.',
    },
    {
      title: '7. VOLUNTARY AGREEMENT',
      body: 'I confirm I am signing willingly and that no coercion or pressure was involved.',
    },
    {
      title: '8. DIGITAL SIGNATURE AGREEMENT',
      body: 'I agree that my electronic signature is legally binding and that this agreement is enforceable as a written contract.',
    },
  ];

  for (const section of agreementSections) {
    checkPageBreak(50);
    drawText(section.title, marginLeft, y, 9, timesBold);
    y -= 14;

    // Word wrap body text
    const words = section.body.split(' ');
    let line = '';
    for (const word of words) {
      const testLine = line ? `${line} ${word}` : word;
      if (timesRoman.widthOfTextAtSize(testLine, 9) > contentWidth) {
        checkPageBreak(13);
        drawText(line, marginLeft + 12, y, 9, timesRoman, rgb(0.15, 0.15, 0.15));
        y -= 13;
        line = word;
      } else {
        line = testLine;
      }
    }
    if (line) {
      checkPageBreak(13);
      drawText(line, marginLeft + 12, y, 9, timesRoman, rgb(0.15, 0.15, 0.15));
      y -= 13;
    }
    y -= 8;
  }

  // Signature section
  checkPageBreak(160);
  y -= 10;
  page.drawLine({ start: { x: marginLeft, y }, end: { x: pageWidth - marginRight, y }, thickness: 1.5, color: rgb(0.3, 0.3, 0.3) });
  y -= 20;
  drawText('SIGNATURE BLOCK', marginLeft, y, 11, timesBold);
  y -= 20;

  // Signature image or text
  if (params.signatureImageBase64) {
    try {
      // Remove data URL prefix if present
      const base64Data = params.signatureImageBase64.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
      const imgBytes = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
      const img = await pdfDoc.embedPng(imgBytes);
      const imgDims = img.scale(0.4);
      const imgH = Math.min(imgDims.height, 70);
      const imgW = (imgH / imgDims.height) * imgDims.width;
      checkPageBreak(imgH + 40);
      page.drawImage(img, { x: marginLeft, y: y - imgH, width: imgW, height: imgH });
      y -= imgH + 10;
    } catch {
      // Fall back to text signature if image fails
      drawText(params.signatureText, marginLeft, y, 18, timesRoman, rgb(0.1, 0.1, 0.5));
      y -= 28;
    }
  } else {
    drawText(params.signatureText, marginLeft, y, 20, timesRoman, rgb(0.1, 0.1, 0.5));
    y -= 30;
  }

  page.drawLine({ start: { x: marginLeft, y }, end: { x: marginLeft + 220, y }, thickness: 0.8, color: rgb(0.4, 0.4, 0.4) });
  y -= 12;
  drawText('Participant Signature', marginLeft, y, 8, helvetica, rgb(0.5, 0.5, 0.5));
  y -= 22;

  drawText('Full Legal Name:', marginLeft, y, 9, timesBold);
  drawText(params.participantName, marginLeft + 95, y, 9, timesRoman);
  y -= 16;

  drawText('Date Signed:', marginLeft, y, 9, timesBold);
  drawText(new Date(params.signedAt).toLocaleString('en-US', { timeZone: 'UTC', dateStyle: 'full', timeStyle: 'long' }), marginLeft + 75, y, 9, timesRoman);
  y -= 24;

  // Audit trail box
  checkPageBreak(80);
  page.drawRectangle({ x: marginLeft, y: y - 70, width: contentWidth, height: 75, color: rgb(0.96, 0.96, 0.98), borderColor: rgb(0.8, 0.8, 0.85), borderWidth: 0.8 });
  y -= 10;
  drawText('AUDIT TRAIL', marginLeft + 10, y, 9, helveticaBold, rgb(0.3, 0.3, 0.4));
  y -= 14;
  drawText(`IP Address:`, marginLeft + 10, y, 8, helveticaBold, rgb(0.4, 0.4, 0.4));
  drawText(params.signerIp, marginLeft + 75, y, 8, helvetica, rgb(0.2, 0.2, 0.2));
  y -= 12;

  // Wrap user agent
  const ua = params.signerUserAgent.length > 85 ? params.signerUserAgent.slice(0, 82) + '...' : params.signerUserAgent;
  drawText(`Device:`, marginLeft + 10, y, 8, helveticaBold, rgb(0.4, 0.4, 0.4));
  drawText(ua, marginLeft + 75, y, 8, helvetica, rgb(0.2, 0.2, 0.2));
  y -= 12;

  drawText(`Signed At (UTC):`, marginLeft + 10, y, 8, helveticaBold, rgb(0.4, 0.4, 0.4));
  drawText(params.signedAt, marginLeft + 100, y, 8, helvetica, rgb(0.2, 0.2, 0.2));

  // Footer on all pages
  const pageCount = pdfDoc.getPageCount();
  for (let i = 0; i < pageCount; i++) {
    const pg = pdfDoc.getPage(i);
    const { width, height } = pg.getSize();
    pg.drawLine({ start: { x: marginLeft, y: 45 }, end: { x: width - marginRight, y: 45 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
    pg.drawText(`Yonkamania Creator Studio — Legally binding digital consent form`, { x: marginLeft, y: 32, size: 7, font: helvetica, color: rgb(0.5, 0.5, 0.5) });
    pg.drawText(`Page ${i + 1} of ${pageCount}`, { x: width - marginRight - 50, y: 32, size: 7, font: helvetica, color: rgb(0.5, 0.5, 0.5) });
  }

  return pdfDoc.save();
}

// ---------------------------------------------------------------------------
// Protected: List forms for creator
// ---------------------------------------------------------------------------

consentRouter.get('/forms', authMiddleware, async (c) => {
  const userId = c.get('userId');

  const { data, error } = await supabaseAdmin
    .from('consent_forms')
    .select('*')
    .eq('creator_id', userId)
    .order('created_at', { ascending: false });

  if (error) return c.json({ error: { message: error.message, code: error.code } }, 500);

  return c.json({ data: data ?? [] });
});

// ---------------------------------------------------------------------------
// Protected: Create a new consent form
// ---------------------------------------------------------------------------

consentRouter.post(
  '/forms',
  authMiddleware,
  zValidator('json', z.object({
    participant_name: z.string().min(2),
    participant_email: z.string().email(),
    content_description: z.string().optional(),
  })),
  async (c) => {
    const userId = c.get('userId');
    const { participant_name, participant_email, content_description } = c.req.valid('json');

    const token = crypto.randomUUID();

    const { data, error } = await supabaseAdmin
      .from('consent_forms')
      .insert({
        creator_id: userId,
        participant_name,
        participant_email,
        content_description: content_description ?? null,
        status: 'pending',
        signed: false,
        token,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) return c.json({ error: { message: error.message, code: error.code } }, 500);

    return c.json({ data });
  }
);

// ---------------------------------------------------------------------------
// Public: Get form by token (for signing page)
// ---------------------------------------------------------------------------

consentRouter.get('/sign/:token', async (c) => {
  const token = c.req.param('token');

  const { data: form, error } = await supabaseAdmin
    .from('consent_forms')
    .select('id, participant_name, participant_email, content_description, status, signed, created_at, creator_id')
    .eq('token', token)
    .single();

  if (error || !form) {
    return c.json({ error: { message: 'Form not found', code: 'NOT_FOUND' } }, 404);
  }

  // If already signed, return with signed status but no re-signing
  if (form.signed) {
    return c.json({ data: { ...form, alreadySigned: true } });
  }

  // Fetch creator name
  const { data: creator } = await supabaseAdmin
    .from('profiles')
    .select('display_name, username')
    .eq('id', form.creator_id)
    .single();

  const creatorName = creator?.display_name ?? creator?.username ?? 'Unknown Creator';

  // Mark as viewed if not already
  if (form.status === 'pending') {
    await supabaseAdmin
      .from('consent_forms')
      .update({ status: 'viewed', viewed_at: new Date().toISOString() })
      .eq('token', token);
  }

  return c.json({
    data: {
      ...form,
      creatorName,
      alreadySigned: false,
    },
  });
});

// ---------------------------------------------------------------------------
// Public: Submit signed form
// ---------------------------------------------------------------------------

consentRouter.post(
  '/sign/:token',
  zValidator('json', z.object({
    signature_text: z.string().min(2),
    signature_image_base64: z.string().optional(),
    agreed: z.boolean(),
  })),
  async (c) => {
    const token = c.req.param('token');
    const { signature_text, signature_image_base64, agreed } = c.req.valid('json');

    if (!agreed) {
      return c.json({ error: { message: 'You must agree to the terms', code: 'NOT_AGREED' } }, 400);
    }

    // Fetch form
    const { data: form, error: formError } = await supabaseAdmin
      .from('consent_forms')
      .select('*')
      .eq('token', token)
      .single();

    if (formError || !form) {
      return c.json({ error: { message: 'Form not found', code: 'NOT_FOUND' } }, 404);
    }

    if (form.signed) {
      return c.json({ error: { message: 'This form has already been signed', code: 'ALREADY_SIGNED' } }, 400);
    }

    // Capture IP and user agent
    const signerIp =
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      c.req.header('x-real-ip') ??
      c.req.header('cf-connecting-ip') ??
      'unknown';
    const signerUserAgent = c.req.header('user-agent') ?? 'unknown';

    // Fetch creator name for PDF
    const { data: creator } = await supabaseAdmin
      .from('profiles')
      .select('display_name, username')
      .eq('id', form.creator_id)
      .single();

    const creatorName = creator?.display_name ?? creator?.username ?? 'Unknown Creator';
    const signedAt = new Date().toISOString();

    // Handle signature image upload if provided
    let signatureImageUrl: string | null = null;
    if (signature_image_base64) {
      try {
        const base64Data = signature_image_base64.replace(/^data:image\/(png|jpeg|jpg);base64,/, '');
        const imgBytes = Uint8Array.from(atob(base64Data), ch => ch.charCodeAt(0));
        const fileName = `sig_${form.id}_${Date.now()}.png`;
        const { error: uploadErr } = await supabaseAdmin.storage
          .from('consent-signatures')
          .upload(fileName, imgBytes, { contentType: 'image/png', upsert: true });
        if (!uploadErr) {
          const { data: urlData } = supabaseAdmin.storage.from('consent-signatures').getPublicUrl(fileName);
          signatureImageUrl = urlData.publicUrl;
        }
      } catch (e) {
        console.error('Signature image upload failed:', e);
      }
    }

    // Generate PDF
    let pdfUrl: string | null = null;
    try {
      const pdfBytes = await generateConsentPDF({
        creatorName,
        participantName: form.participant_name,
        contentDescription: form.content_description ?? undefined,
        signatureText: signature_text,
        signatureImageBase64: signature_image_base64,
        signedAt,
        signerIp,
        signerUserAgent,
      });

      const pdfFileName = `consent_${form.id}_${Date.now()}.pdf`;
      const { error: pdfErr } = await supabaseAdmin.storage
        .from('consent-pdfs')
        .upload(pdfFileName, pdfBytes, { contentType: 'application/pdf', upsert: true });

      if (!pdfErr) {
        const { data: pdfUrlData } = supabaseAdmin.storage.from('consent-pdfs').getPublicUrl(pdfFileName);
        pdfUrl = pdfUrlData.publicUrl;
      }
    } catch (e) {
      console.error('PDF generation failed:', e);
    }

    // Update form as signed
    const { error: updateError } = await supabaseAdmin
      .from('consent_forms')
      .update({
        signed: true,
        status: 'signed',
        signed_at: signedAt,
        signature_text,
        signature_image_url: signatureImageUrl,
        signer_ip: signerIp,
        signer_user_agent: signerUserAgent,
        pdf_url: pdfUrl,
      })
      .eq('token', token);

    if (updateError) {
      return c.json({ error: { message: updateError.message, code: updateError.code } }, 500);
    }

    return c.json({ data: { success: true, pdfUrl } });
  }
);

// ---------------------------------------------------------------------------
// Protected: Delete a form (only if pending)
// ---------------------------------------------------------------------------

consentRouter.delete('/forms/:id', authMiddleware, async (c) => {
  const userId = c.get('userId');
  const id = c.req.param('id');

  const { data: form } = await supabaseAdmin
    .from('consent_forms')
    .select('creator_id, signed')
    .eq('id', id)
    .single();

  if (!form || form.creator_id !== userId) {
    return c.json({ error: { message: 'Not found', code: 'NOT_FOUND' } }, 404);
  }

  if (form.signed) {
    return c.json({ error: { message: 'Cannot delete a signed form', code: 'FORBIDDEN' } }, 403);
  }

  await supabaseAdmin.from('consent_forms').delete().eq('id', id);

  return c.json({ data: { success: true } });
});

export { consentRouter };
