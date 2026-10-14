import { readPublicationPayloadGit } from "./publication-git.js";
import {
  verifyPublicationPayload,
  type PublicationExpectation,
} from "./publication-payload.js";

/** Reviewed source-repository transport; test transports emulate that authority. */
export interface PublicationArtifactTransport {
  readonly repository: "prodigic/zivv";
  readHead(ref: string): string | null;
  fetchCommit(commit: string): void;
  append(ref: string, commit: string, expectedHead: string | null): void;
}

export interface RetainedPublicationArtifact {
  status: "retained" | "conflict" | "uncertain";
  ref: string;
  payloadCommit: string;
  observedHead: string | null;
  candidateId: string;
  receiptId: string;
}

/**
 * Root an exact verified payload in a non-served immutable artifact reference.
 * A failed/uncertain write is observed, never reparented or force-pushed.
 */
export function retainPublicationArtifact(
  input: PublicationExpectation & {
    repositoryRoot: string;
    payloadCommit: string;
    transport: PublicationArtifactTransport;
  }
): RetainedPublicationArtifact {
  if (
    input.transport.repository !== "prodigic/zivv" ||
    !/^[a-f0-9]{40}$/.test(input.payloadCommit)
  )
    throw new Error(
      "Artifact retention requires the authoritative repository and exact commit"
    );
  const expected = {
    expectedCandidateId: input.expectedCandidateId,
    expectedSourceCommit: input.expectedSourceCommit,
    purpose: input.purpose,
    basePath: input.basePath,
  };
  const payloadCommit = input.payloadCommit;
  const repositoryRoot = input.repositoryRoot;
  const transport = input.transport;
  const checked = verifyPublicationPayload(
    readPublicationPayloadGit({ repositoryRoot, payloadCommit }).files,
    expected
  );
  const ref = "refs/heads/zivv-candidate-artifacts/" + payloadCommit;
  const result = (
    status: RetainedPublicationArtifact["status"],
    observedHead: string | null
  ): RetainedPublicationArtifact => ({
    status,
    ref,
    payloadCommit,
    observedHead,
    candidateId: checked.receipt.candidate.candidateId,
    receiptId: checked.receipt.receiptId,
  });
  function observe(): RetainedPublicationArtifact {
    const observedHead = transport.readHead(ref);
    if (observedHead === null) return result("uncertain", null);
    if (observedHead !== payloadCommit) return result("conflict", observedHead);
    // Fetch exact remote identity, not a moving branch tip, then recheck raw bytes.
    transport.fetchCommit(payloadCommit);
    verifyPublicationPayload(
      readPublicationPayloadGit({ repositoryRoot, payloadCommit }).files,
      expected
    );
    return result("retained", observedHead);
  }
  const previous = transport.readHead(ref);
  if (previous !== null) return observe();
  try {
    transport.append(ref, payloadCommit, null);
  } catch {
    // A lost response can follow a successful push; observe the same immutable ref.
  }
  try {
    return observe();
  } catch {
    // Missing or inaccessible readback never authorizes deployment or a force retry.
    return result("uncertain", null);
  }
}
