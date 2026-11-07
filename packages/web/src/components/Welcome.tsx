import React, { useState } from "react";
import { seedDemo, gmailAuthUrl, signInWithGoogle } from "../sync/ConvexSync";
import { desktopBridge } from "../lib/desktopBridge";

// The newest Mac build under a stable name (the release script uploads it
// beside the versioned one).
const MAC_DOWNLOAD = "https://dl.whisk.email/desktop/Whisk-arm64.dmg";

export function GoogleMark(): React.ReactElement {
  return (
    <svg className="welcome-g" viewBox="0 0 24 24" width="15" height="15" aria-hidden>
      <path
        fill="currentColor"
        d="M21.6 12.23c0-.68-.06-1.36-.19-2.02H12v3.82h5.4a4.6 4.6 0 0 1-2 3.02v2.5h3.23c1.9-1.74 2.97-4.3 2.97-7.32Z"
      />
      <path
        fill="currentColor"
        d="M12 21.94c2.7 0 4.96-.9 6.62-2.4l-3.23-2.5c-.9.6-2.05.95-3.39.95-2.6 0-4.8-1.75-5.6-4.1H3.07v2.58A10 10 0 0 0 12 21.94Z"
        opacity=".75"
      />
      <path fill="currentColor" d="M6.4 13.88a6 6 0 0 1 0-3.82V7.48H3.07a10 10 0 0 0 0 8.98l3.34-2.58Z" opacity=".55" />
      <path
        fill="currentColor"
        d="M12 5.95c1.47 0 2.79.5 3.82 1.5l2.87-2.87A9.97 9.97 0 0 0 3.07 7.48L6.4 10.06c.8-2.36 3-4.1 5.6-4.1Z"
        opacity=".9"
      />
    </svg>
  );
}

const FEATURES = [
  {
    title: "Your calendar, next to your mail",
    body: "See the day at a glance, answer invitations, and find a free half hour without switching apps.",
    shot: "/shots/calendar.webp",
    size: [2096, 1400],
    alt: "Whisk's calendar showing today's meetings beside the mail folders",
  },
  {
    title: "Conversations that read well",
    body: "Long threads fold to one line per reply, quoted trails tuck away, and messages are set in type made for reading.",
    shot: "/shots/thread.webp",
    size: [2096, 1330],
    alt: "A long email conversation in Whisk with earlier replies folded",
  },
];

export function Welcome(): React.ReactElement {
  const [seeding, setSeeding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSignIn = !!gmailAuthUrl();
  // Inside the Mac app there is nothing to download.
  const inApp = !!desktopBridge();

  const tryDemo = async () => {
    setSeeding(true);
    setError(null);
    try {
      await seedDemo();
    } catch (e) {
      setError(String((e as Error).message ?? e));
      setSeeding(false);
    }
  };

  const signIn = canSignIn ? (
    <button className="welcome-secondary" onClick={signInWithGoogle}>
      <GoogleMark />
      Continue with Google
    </button>
  ) : null;

  return (
    <div className="landing">
      <header className="landing-top">
        <span className="landing-brand">
          <span className="landing-brand-mark" aria-hidden>
            ✉
          </span>
          Whisk
        </span>
        {canSignIn && (
          <button className="landing-signin" onClick={signInWithGoogle}>
            Sign in
          </button>
        )}
      </header>

      <section className="landing-hero">
        <h1 className="landing-title">A better home for your Gmail.</h1>
        <p className="landing-lede">
          Whisk is an email client with your calendar built in. It opens instantly, works offline, and keeps
          everything in step across your Mac, your browser and your iPhone.
        </p>
        <div className="landing-actions">
          {inApp ? (
            signIn
          ) : (
            <>
              <a className="welcome-primary" href={MAC_DOWNLOAD}>
                Download for Mac
              </a>
              {signIn}
            </>
          )}
        </div>
        <button className="landing-demo" disabled={seeding} onClick={tryDemo}>
          {seeding ? "Setting up a demo mailbox…" : "or look around a demo mailbox first"}
        </button>
        {!canSignIn && (
          <div className="welcome-note">
            Connecting Gmail needs <code>GMAIL_CLIENT_ID</code> configured. The demo works instantly.
          </div>
        )}
        {error && <div className="welcome-error">{error}</div>}
      </section>

      <figure className="landing-stage">
        <img
          className="landing-window"
          src="/shots/inbox.webp"
          alt="The Whisk inbox on a Mac, with mail sorted into lanes and topics"
          width={2560}
          height={1600}
        />
        <img
          className="landing-phone"
          src="/shots/phone.webp"
          alt="The Whisk inbox on an iPhone"
          width={720}
          height={1565}
          loading="lazy"
        />
      </figure>

      <section className="landing-features">
        {FEATURES.map((f) => (
          <article key={f.title} className="landing-feature">
            <div className="landing-feature-text">
              <h2>{f.title}</h2>
              <p>{f.body}</p>
            </div>
            <img src={f.shot} alt={f.alt} width={f.size[0]} height={f.size[1]} loading="lazy" />
          </article>
        ))}
      </section>

      <section className="landing-devices">
        <h2>On every screen you use</h2>
        <p>Read on the train, answer at your desk. Anything you do offline goes out the moment you're back online.</p>
        <div className="landing-device-grid">
          <div className="landing-device">
            <h3>Mac</h3>
            <p>A native window, notifications, and the default mail app for your links. Updates itself.</p>
            {!inApp && <a href={MAC_DOWNLOAD}>Download for Apple silicon</a>}
          </div>
          <div className="landing-device">
            <h3>Web</h3>
            <p>The same app in any browser at whisk.email, nothing to install.</p>
          </div>
          <div className="landing-device">
            <h3>iPhone</h3>
            <p>Swipe to archive, reply inline, and get new mail as it lands.</p>
            <span className="landing-soon">Coming soon to the App Store</span>
          </div>
        </div>
      </section>

      <footer className="landing-foot">
        <span>Your mail is never sold, never used for ads, never used to train AI.</span>
        <span className="landing-foot-links">
          <a href="/privacy/">Privacy</a>
          <a href="/terms/">Terms</a>
          <a href="mailto:ashot@almostcandid.com">Contact</a>
        </span>
      </footer>
    </div>
  );
}
