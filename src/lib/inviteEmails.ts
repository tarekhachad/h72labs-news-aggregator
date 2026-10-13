/**
 * The three emails invite requests send. The canonical copy is in
 * docs/(C) EMAIL_TEMPLATES.md, which is external-facing text: change the
 * two together, and run the writing check first.
 *
 * Plain text only, so nothing a requester typed can become markup. The
 * decline email carries none of the requester's words at all: anyone can
 * put a stranger's address on a request, and declining with an email would
 * then deliver their text to that stranger.
 */

import { INVITE_TTL_DAYS } from "./invite";
import type { OutgoingEmail } from "./email";
import type { InviteRequestFields } from "./inviteRequest";

export function approvalEmail(to: string, name: string, link: string): OutgoingEmail {
  return {
    to,
    subject: "Your invite to H72 Labs News",
    text: [
      `Hi ${name},`,
      "",
      "Thanks for asking to try H72 Labs News. Here's your invite link:",
      "",
      link,
      "",
      `It works once, for ${to}, and expires in ${INVITE_TTL_DAYS} days. After you sign up, you pick the topics and countries you want to follow, and the app writes the day's stories on them as short cards, each one drawn from several outlets' reporting.`,
      "",
      "Tarek",
      "H72 Labs",
    ].join("\n"),
  };
}

export function declineEmail(to: string): OutgoingEmail {
  return {
    to,
    subject: "Your request to try H72 Labs News",
    text: [
      "Hi,",
      "",
      "Thanks for asking to try H72 Labs News. It's a small invite-only test for now, and I can't add more readers at this stage. You're welcome to ask again later.",
      "",
      "Tarek",
      "H72 Labs",
    ].join("\n"),
  };
}

/** To Tarek, so his own inbox, and labelled where the requester wrote it. */
export function newRequestEmail(
  to: string,
  request: InviteRequestFields,
  adminUrl: string
): OutgoingEmail {
  return {
    to,
    subject: `Invite request from ${request.name}`,
    text: [
      `${request.name} <${request.email}> asked for an invite.`,
      "",
      `How they heard about it: ${request.referral}`,
      `What they'd like to read: ${request.interests}`,
      `Their note: ${request.note}`,
      ...(request.link ? [`Link they gave (unchecked): ${request.link}`] : []),
      "",
      `Approve or decline: ${adminUrl}`,
    ].join("\n"),
  };
}
