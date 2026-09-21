import nodemailer from "nodemailer";

/**
 * Invitation email rendering + SMTP delivery. The message contains only the
 * first-party accept URL — no third-party assets, no tracking, and the raw
 * token appears nowhere in logs (transport errors are redacted to codes).
 */

export interface InvitationEmailPayload {
  to: string;
  workspaceName: string;
  acceptUrl: string;
}

export function renderInvitationEmail(payload: InvitationEmailPayload): { subject: string; text: string; html: string } {
  const subject = `You're invited to join "${payload.workspaceName}" on PromptBranch`;
  const text = [
    `You have been invited to the workspace "${payload.workspaceName}" on PromptBranch.`,
    ``,
    `Open this link to accept (it expires in 7 days and works only for your verified email address):`,
    payload.acceptUrl,
    ``,
    `If you did not expect this invitation you can ignore this email.`,
  ].join("\n");
  const html = [
    `<p>You have been invited to the workspace <strong>${escapeHtml(payload.workspaceName)}</strong> on PromptBranch.</p>`,
    `<p><a href="${escapeHtml(payload.acceptUrl)}">Accept the invitation</a> (expires in 7 days, and works only for your verified email address).</p>`,
    `<p style="color:#666">If you did not expect this invitation you can ignore this email.</p>`,
  ].join("\n");
  return { subject, text, html };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export async function sendInvitationEmail(
  options: { smtpUrl: string; from: string },
  payload: InvitationEmailPayload,
): Promise<void> {
  const transport = nodemailer.createTransport(options.smtpUrl);
  const message = renderInvitationEmail(payload);
  try {
    await transport.sendMail({
      from: options.from,
      to: payload.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
  } catch (error) {
    // Redact everything but the classification: SMTP responses can echo
    // message content, and the body carries the invitation secret.
    const code = (error as { responseCode?: number }).responseCode ?? (error as { code?: string }).code ?? "SMTP_ERROR";
    throw Object.assign(new Error(`invitation email delivery failed (${String(code)})`), { code: "EMAIL_DELIVERY_FAILED" });
  } finally {
    transport.close();
  }
}
