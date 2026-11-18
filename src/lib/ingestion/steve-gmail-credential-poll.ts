import { isAbsolute, relative, resolve, sep } from "node:path";
import { createGmailAccessTokenProvider } from "./gmail-oauth-refresh.js";
import { assertOperatorNotQuarantined } from "./private-artifacts.js";
import { captureSteveGmailWindow } from "./steve-gmail-handoff.js";
import { withWindowsGmailCredentials } from "./windows-gmail-credentials.js";

type CaptureInput = Omit<
  Parameters<typeof captureSteveGmailWindow>[0],
  "getAccessToken"
>;

function inside(parent: string, child: string): boolean {
  const difference = relative(parent, child);
  return (
    difference !== ".." &&
    !difference.startsWith(`..${sep}`) &&
    !isAbsolute(difference)
  );
}

/** Poll through the existing handoff; only fresh Gmail reads unlock credentials. */
export function captureSteveGmailWindowWithWindowsCredentials({
  credentialDirectory,
  ...input
}: CaptureInput & { credentialDirectory: string }) {
  const operatorDirectory = resolve(input.operatorDirectory);
  const credentialPath = resolve(credentialDirectory);
  if (
    inside(operatorDirectory, credentialPath) ||
    inside(credentialPath, operatorDirectory)
  )
    throw Error("GMAIL_CREDENTIAL_STORAGE_UNSAFE");

  return captureSteveGmailWindow({
    ...input,
    operatorDirectory,
    getAccessToken: async () => {
      assertOperatorNotQuarantined(operatorDirectory);
      const accessToken = await withWindowsGmailCredentials(
        credentialPath,
        (credentials) =>
          createGmailAccessTokenProvider({
            ...credentials,
            fetcher: input.fetcher,
          })()
      );
      assertOperatorNotQuarantined(operatorDirectory);
      return accessToken;
    },
  });
}
