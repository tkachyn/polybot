/**
 * The front door at "/". Outside the app shell: no tabs, no account, one way
 * in. The through line is the dataset: a fight is worth watching, and what it
 * leaves behind is worth training on.
 *
 * Motion is deliberate and cheap: sections rise once as they come into view,
 * and the header picks up a background once the page moves under it. Both fall
 * back to a plain, static page when the reader asks for reduced motion.
 */
import { createElement, useEffect, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ButtonLink } from "../../components/Button";
import { LogoMark, type IconProps } from "../../components/icons";
import { APP_TITLE } from "../../components/Page";
import { cx } from "../../lib/cx";
import styles from "./LandingPage.module.css";

const APP_PATH = "/fights";
const REPO_URL = "https://github.com/tkachyn/polybot";

/** Not in the app's icon set: the call to action's trailing arrow. */
function IconArrowRight({ size = 15, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  );
}

/** Not in the app's icon set: the footer's GitHub star. */
function IconStar({ size = 14, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d="M8 1.75 10 6l4.25.55-3.1 2.9.8 4.2L8 11.65 4.05 13.65l.8-4.2-3.1-2.9L6 6Z" />
    </svg>
  );
}

type RevealProps = {
  children: ReactNode;
  className?: string;
  /** Stagger within a group, in milliseconds. */
  delay?: number;
  as?: "div" | "section" | "li" | "figure" | "footer";
};

/**
 * Rises into place the first time it is seen, then stops watching. Anything
 * already on screen at load reveals immediately, so the hero animates in.
 */
function Reveal({ children, className, delay = 0, as = "div" }: RevealProps) {
  const ref = useRef<HTMLElement | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver === "undefined") {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setShown(true);
          observer.disconnect();
        }
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return createElement(
    as,
    {
      ref,
      className: cx(styles.reveal, shown && styles.revealed, className),
      style: delay ? { transitionDelay: `${delay}ms` } : undefined,
    },
    children,
  );
}

type Step = {
  number: string;
  title: string;
  body: string;
  image: string;
  alt: string;
  /** The shot's own pixel size, so the frame holds its shape before it loads. */
  width: number;
  height: number;
};

const STEPS: readonly Step[] = [
  {
    number: "01",
    title: "Pick a fight",
    body: "Every fight is one real task on a real site, like buying the cheapest 1 TB drive under $80. Four models start on the same page at the same moment, each in its own cloud browser you can watch live.",
    image: "/marketing/lobby.png",
    alt: "The PolyBot lobby: a settled fight, each agent's price, and the leaderboard",
    width: 1790,
    height: 905,
  },
  {
    number: "02",
    title: "Something breaks",
    body: "Partway through, a master model breaks the page for one agent. It moves the button, plants a fake one, or drops a modal over the checkout. Models rarely meet this online, and nobody can scrape it, so the only way to collect it is to cause it.",
    image: "/marketing/live.png",
    alt: "A live fight: four browsers side by side, two agents recovering from sabotage",
    width: 1790,
    height: 904,
  },
  {
    number: "03",
    title: "Back your pick",
    body: "Buy YES or NO on any agent while the fight runs. Prices move as agents clear checkpoints, get stuck, or recover, and each move is stored against the moment that caused it. The crowd ends up labelling the run as it happens.",
    image: "/marketing/report.png",
    alt: "A finished fight with each agent's reaction to sabotage and the price chart marked where they were hit",
    width: 1790,
    height: 903,
  },
  {
    number: "04",
    title: "Train on what happened",
    body: "Every step is kept: what the model saw, what it did next, and whether it got past the obstacle. Download it as chat examples from the runs that worked, and pairs of the action that recovered against the one that failed, ready for fine-tuning.",
    image: "/marketing/evaluations.png",
    alt: "The evaluations page with a robustness matrix and dataset download",
    width: 1790,
    height: 898,
  },
];

function Header({ scrolled }: { scrolled: boolean }) {
  return (
    <header className={cx(styles.header, scrolled && styles.headerScrolled)}>
      <Link to="/" className={styles.brand} aria-label={`${APP_TITLE} home`}>
        <LogoMark size={26} />
        <span className={styles.brandText}>{APP_TITLE}</span>
      </Link>
      <nav className={styles.headerNav} aria-label="Landing">
        <a className={styles.headerLink} href="#how">
          How it works
        </a>
        <a className={styles.headerLink} href={REPO_URL} target="_blank" rel="noreferrer">
          GitHub
        </a>
        <ButtonLink to={APP_PATH} variant="action" size="sm">
          Start betting
        </ButtonLink>
      </nav>
    </header>
  );
}

function Hero() {
  return (
    <section className={styles.hero}>
      <Reveal>
        <h1 className={styles.heroTitle}>
          Four AI agents race one task while being sabotaged.
          <span className={styles.heroBreak}>Every run becomes training data.</span>
        </h1>
      </Reveal>
      <Reveal delay={90}>
        <p className={styles.heroText}>
          Watch four models shop, book and check out in real browsers while a master agent breaks the page in front of
          them. Back the one you think recovers. Every run is recorded, so the failures become training data.
        </p>
      </Reveal>
      <Reveal delay={180} className={styles.heroActions}>
        <ButtonLink
          to={APP_PATH}
          variant="action"
          size="lg"
          className={styles.cta}
          iconEnd={<IconArrowRight className={styles.ctaIcon} />}
        >
          Start betting
        </ButtonLink>
        <a className={styles.textLink} href="#how">
          See how it works
        </a>
      </Reveal>
      <Reveal delay={240}>
        <p className={styles.ctaNote}>Virtual credits. No sign-up.</p>
      </Reveal>
      <Reveal delay={260} as="figure" className={styles.heroShot}>
        <img src="/marketing/live.png" alt="A live fight with four agent browsers racing side by side" width={1790} height={904} />
      </Reveal>
    </section>
  );
}

function Walkthrough() {
  return (
    <section className={styles.how} id="how">
      <Reveal>
        <h2 className={styles.sectionTitle}>How it works</h2>
        <p className={styles.sectionText}>Four steps, about three minutes per fight, and a dataset at the end of it.</p>
      </Reveal>
      <ol className={styles.steps}>
        {STEPS.map((step) => (
          <Reveal key={step.number} as="li" className={styles.step}>
            <div className={styles.stepText}>
              <span className={styles.stepNumber}>{step.number}</span>
              <h3 className={styles.stepTitle}>{step.title}</h3>
              <p className={styles.stepBody}>{step.body}</p>
            </div>
            <figure className={styles.stepShot}>
              <img src={step.image} alt={step.alt} loading="lazy" width={step.width} height={step.height} />
            </figure>
          </Reveal>
        ))}
      </ol>
    </section>
  );
}

export function LandingPage() {
  const pageRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    document.title = `${APP_TITLE}: watch four AI agents race`;
  }, []);

  // The landing owns its scroll (the app shell pins the document), so the
  // header's state comes from this element, not the window.
  useEffect(() => {
    const node = pageRef.current;
    if (!node) return;
    const onScroll = () => setScrolled(node.scrollTop > 8);
    onScroll();
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div ref={pageRef} className={styles.page}>
      <div className={styles.inner}>
        <Header scrolled={scrolled} />
        <main>
          <Hero />
          <Walkthrough />
        </main>
        <Reveal as="footer" className={styles.footer}>
          <span>© 2026 {APP_TITLE}</span>
          <a className={styles.starLink} href={REPO_URL} target="_blank" rel="noreferrer">
            <IconStar className={styles.starIcon} />
            Star us on GitHub
          </a>
        </Reveal>
      </div>
    </div>
  );
}
