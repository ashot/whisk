import React, { useState } from "react";

/** The paste-into-a-terminal form of a device login. Shown once; the token
 *  is never retrievable again, so the copy button is the whole affordance. */
export function TokenCommand({ token }: { token: string }): React.ReactElement {
  const [copied, setCopied] = useState(false);
  const command = `whisk login ${token}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };
  return (
    <div className="token-command">
      <code className="token-command-text">{command}</code>
      <button className="settings-btn" onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}
