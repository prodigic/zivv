/**
 * THROWAWAY: thirteen single-tile show/map treatments.
 * Uses the existing event route and real data, selected with ?variant=1..13.
 * Only rendered in the explicitly enabled prototype build.
 */
import { useCallback, useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import VenueNameLink from "@/components/ui/VenueNameLink.js";
import type { Event, Venue } from "@/types/events.js";
import { getVenueMapTile } from "@/utils/venue-map.js";
import "./VenueTileTreatments.prototype.css";

const treatments = [
  { name: "Clean Split", idea: "Quiet hierarchy · one shared surface" },
  { name: "Transparent Atlas", idea: "Map wallpaper · floating typography" },
  { name: "Night Glass", idea: "Transparent glass · luminous wallpaper" },
  { name: "Gig Poster", idea: "Big type · ink and paper · map sticker" },
  { name: "Editorial", idea: "Serif headline · generous map · warm paper" },
  { name: "Transit Strip", idea: "Map first · compact itinerary" },
  {
    name: "Ticket Window",
    idea: "Clear surface · circular map · tear-off date",
  },
  {
    name: "Daylight Atlas",
    idea: "From 02 · pale map wallpaper · frosted footer",
  },
  {
    name: "Nightfall",
    idea: "From 02 · open map above · type fading into ink",
  },
  {
    name: "Riso Flyer",
    idea: "From 04 · red ink · oversized date · paper map",
  },
  {
    name: "Blackout Bill",
    idea: "From 04 · stacked typography · electric map band",
  },
  {
    name: "Route Board",
    idea: "From 06 · panoramic map · two-stop show itinerary",
  },
  { name: "Platform Pass", idea: "From 06 · date spine · destination and map" },
];

type Props = {
  event: Event;
  venue: Venue;
  headlinerName: string;
  supportNames: string[];
};

function MapArtwork({
  venue,
  wallpaper = false,
  focusMarker = false,
}: {
  venue: Venue;
  wallpaper?: boolean;
  focusMarker?: boolean;
}) {
  const tile = getVenueMapTile(venue.mapLocation);
  if (!tile) return <div className="map-missing">Location not mapped</div>;
  return (
    <div className={`map-art ${wallpaper ? "map-wallpaper" : ""}`}>
      <a
        href={tile.mapUrl}
        aria-label={`Open map for ${venue.name}`}
        className="map-plane"
        style={
          focusMarker
            ? { transform: `translateY(-${(tile.markerY / 256) * 100}%)` }
            : undefined
        }
      >
        <img
          src={tile.url}
          alt={`Street map around ${venue.name}`}
          width="256"
          height="256"
          loading="lazy"
        />
        <span
          className="map-marker"
          aria-hidden="true"
          style={{
            left: `${(tile.markerX / 256) * 100}%`,
            top: `${(tile.markerY / 256) * 100}%`,
          }}
        />
      </a>
      <a className="map-credit" href="https://www.openstreetmap.org/copyright">
        © OpenStreetMap contributors
      </a>
    </div>
  );
}

function MapCaption({ venue }: { venue: Venue }) {
  const tile = getVenueMapTile(venue.mapLocation);
  return (
    <a
      className="map-caption"
      href={
        tile?.mapUrl ??
        `https://www.openstreetmap.org/search?query=${encodeURIComponent(`${venue.name}, ${venue.address}, ${venue.city}`)}`
      }
    >
      {tile ? "Approximate location · open map ↗" : "Search location ↗"}
    </a>
  );
}

function Support({ names }: { names: string[] }) {
  return names.length ? (
    <p className="support">with {names.join(" + ")}</p>
  ) : null;
}

function VenueAddress({ venue }: { venue: Venue }) {
  return (
    <div className="venue-address">
      <VenueNameLink venue={venue} className="venue-name" />
      <p>{[venue.address, venue.city].filter(Boolean).join(", ")}</p>
    </div>
  );
}

function Admission({ event }: { event: Event }) {
  const soldOut =
    event.status === "sold-out" || event.tags?.includes("sold-out");
  return (
    <div className="admission">
      <span className={soldOut ? "admission-status sold" : "admission-status"}>
        {soldOut
          ? "SOLD OUT"
          : event.isFree
            ? "FREE SHOW"
            : event.priceMin != null
              ? `$${event.priceMin}`
              : "LIVE SHOW"}
      </span>
      {event.ageRestriction && <span>{event.ageRestriction}</span>}
      {event.ticketUrl && (
        <a href={event.ticketUrl} target="_blank" rel="noopener noreferrer">
          Tickets ↗
        </a>
      )}
    </div>
  );
}

export default function VenueTileTreatmentsPrototype(props: Props) {
  const { event, venue, headlinerName, supportNames } = props;
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = Number(searchParams.get("variant") ?? 1);
  const active =
    Number.isInteger(requested) &&
    requested >= 1 &&
    requested <= treatments.length
      ? requested
      : 1;
  const study = treatments[active - 1];
  const date = new Date(event.dateEpochMs);
  const month = date.toLocaleDateString("en-US", { month: "short" });
  const day = date.getDate();
  const weekday = date.toLocaleDateString("en-US", { weekday: "long" });
  const dateLabel = date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const time = event.startTimeEpochMs
    ? new Date(event.startTimeEpochMs).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
      })
    : null;
  const choose = useCallback(
    (number: number) => {
      const next = new URLSearchParams(searchParams);
      next.set(
        "variant",
        String(((number - 1 + treatments.length) % treatments.length) + 1)
      );
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams]
  );
  useEffect(() => {
    const cycle = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      if (
        e.target instanceof HTMLElement &&
        (e.target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName))
      )
        return;
      e.preventDefault();
      choose(active + (e.key === "ArrowRight" ? 1 : -1));
    };
    window.addEventListener("keydown", cycle);
    return () => window.removeEventListener("keydown", cycle);
  }, [active, choose]);

  return (
    <div className="prototype-treatments">
      <div className="study-label">
        <span>STUDY {String(active).padStart(2, "0")}</span>
        <strong>{study.name}</strong>
        <span>{study.idea}</span>
      </div>
      <div className={`prototype-stage stage-${active}`}>
        {active === 1 && (
          <article
            className="treatment clean-split"
            aria-label="Combined show and map tile"
          >
            <div className="split-copy">
              <div className="eyebrow">
                {dateLabel}
                {time ? ` · ${time}` : ""}
              </div>
              <h2>{headlinerName}</h2>
              <Support names={supportNames} />
              <VenueAddress venue={venue} />
              <Admission event={event} />
            </div>
            <div className="split-map">
              <MapArtwork venue={venue} />
              <MapCaption venue={venue} />
            </div>
          </article>
        )}

        {active === 2 && (
          <article
            className="treatment transparent-atlas"
            aria-label="Combined show and map tile"
          >
            <MapArtwork venue={venue} wallpaper />
            <div className="atlas-shade" />
            <div className="atlas-copy">
              <div className="eyebrow">
                {weekday} / {month} {day} / {time}
              </div>
              <h2>{headlinerName}</h2>
              <Support names={supportNames} />
              <div className="atlas-bottom">
                <VenueAddress venue={venue} />
                <Admission event={event} />
              </div>
            </div>
            <MapCaption venue={venue} />
          </article>
        )}

        {active === 3 && (
          <article
            className="treatment night-glass"
            aria-label="Combined show and map tile"
          >
            <div className="glass-top">
              <span className="eyebrow">ONE NIGHT / SAN FRANCISCO</span>
              <span>
                {month} {day}
              </span>
            </div>
            <div className="glass-body">
              <div>
                <h2>{headlinerName}</h2>
                <Support names={supportNames} />
                <VenueAddress venue={venue} />
                <div className="glass-time">
                  {weekday} · {time}
                </div>
                <Admission event={event} />
              </div>
              <div className="glass-map">
                <MapArtwork venue={venue} />
                <MapCaption venue={venue} />
              </div>
            </div>
          </article>
        )}

        {active === 4 && (
          <article
            className="treatment gig-poster"
            aria-label="Combined show and map tile"
          >
            <div className="poster-date">
              <span>{weekday.toUpperCase()}</span>
              <strong>
                {month.toUpperCase()} {day}
              </strong>
              <span>{time}</span>
            </div>
            <h2>{headlinerName}</h2>
            <Support names={supportNames} />
            <div className="poster-bottom">
              <div>
                <VenueAddress venue={venue} />
                <Admission event={event} />
                <p className="poster-note">LOUD MUSIC. GOOD COMPANY.</p>
              </div>
              <div className="poster-map">
                <MapArtwork venue={venue} />
                <MapCaption venue={venue} />
              </div>
            </div>
          </article>
        )}

        {active === 5 && (
          <article
            className="treatment editorial"
            aria-label="Combined show and map tile"
          >
            <div className="editorial-line">
              <span>A NIGHT IN THE CITY</span>
              <span>{date.getFullYear()}</span>
            </div>
            <h2>{headlinerName}</h2>
            <Support names={supportNames} />
            <div className="editorial-body">
              <div className="editorial-calendar">
                <span>{month}</span>
                <strong>{day}</strong>
                <p>
                  {weekday}
                  <br />
                  {time}
                </p>
                <Admission event={event} />
              </div>
              <div>
                <MapArtwork venue={venue} />
                <MapCaption venue={venue} />
              </div>
            </div>
            <VenueAddress venue={venue} />
          </article>
        )}

        {active === 6 && (
          <article
            className="treatment transit-strip"
            aria-label="Combined show and map tile"
          >
            <div className="transit-map">
              <MapArtwork venue={venue} wallpaper />
              <span className="transit-stop">SF</span>
            </div>
            <div className="transit-copy">
              <div className="eyebrow">NEXT STOP / LIVE MUSIC</div>
              <h2>{headlinerName}</h2>
              <Support names={supportNames} />
              <div className="transit-date">
                <strong>
                  {month} {day}
                </strong>
                <span>
                  {weekday}
                  <br />
                  {time}
                </span>
              </div>
              <VenueAddress venue={venue} />
              <Admission event={event} />
              <MapCaption venue={venue} />
            </div>
          </article>
        )}

        {active === 7 && (
          <article
            className="treatment ticket-window"
            aria-label="Combined show and map tile"
          >
            <div className="ticket-top">
              <span className="eyebrow">AN EVENING WITH</span>
              <Admission event={event} />
            </div>
            <div className="ticket-body">
              <div>
                <h2>{headlinerName}</h2>
                <Support names={supportNames} />
                <VenueAddress venue={venue} />
              </div>
              <div className="ticket-map">
                <MapArtwork venue={venue} />
                <MapCaption venue={venue} />
              </div>
            </div>
            <div className="ticket-stub">
              <strong>
                {month} {day}
              </strong>
              <span>{weekday}</span>
              <strong>{time}</strong>
            </div>
          </article>
        )}
        {active === 8 && (
          <article
            className="treatment daylight-atlas"
            aria-label="Combined show and map tile"
          >
            <MapArtwork venue={venue} wallpaper />
            <div className="daylight-wash" />
            <div className="daylight-heading">
              <div className="eyebrow">LIVE IN {venue.city}</div>
              <h2>{headlinerName}</h2>
              <Support names={supportNames} />
            </div>
            <div className="daylight-footer">
              <div className="daylight-date">
                <strong>
                  {month} {day}
                </strong>
                <span>
                  {weekday} · {time}
                </span>
              </div>
              <VenueAddress venue={venue} />
              <Admission event={event} />
              <MapCaption venue={venue} />
            </div>
          </article>
        )}
        {active === 9 && (
          <article
            className="treatment nightfall"
            aria-label="Combined show and map tile"
          >
            <MapArtwork venue={venue} wallpaper />
            <div className="nightfall-shade" />
            <div className="nightfall-top">
              <span className="eyebrow">{venue.city}</span>
              <span className="nightfall-date">
                {month}
                <strong>{day}</strong>
              </span>
            </div>
            <div className="nightfall-copy">
              <div className="eyebrow">
                {weekday} / {time}
              </div>
              <h2>{headlinerName}</h2>
              <Support names={supportNames} />
              <div className="nightfall-bottom">
                <VenueAddress venue={venue} />
                <Admission event={event} />
              </div>
              <MapCaption venue={venue} />
            </div>
          </article>
        )}
        {active === 10 && (
          <article
            className="treatment riso-flyer"
            aria-label="Combined show and map tile"
          >
            <div className="riso-masthead">
              <span>ONE NIGHT ONLY</span>
              <span>
                {venue.city} / {date.getFullYear()}
              </span>
            </div>
            <div className="riso-title">
              <h2>{headlinerName}</h2>
              <Support names={supportNames} />
            </div>
            <div className="riso-grid">
              <div className="riso-date">
                <span>{month}</span>
                <strong>{String(day).padStart(2, "0")}</strong>
                <span>
                  {weekday}
                  <br />
                  {time}
                </span>
              </div>
              <div className="riso-map">
                <MapArtwork venue={venue} />
                <MapCaption venue={venue} />
              </div>
            </div>
            <div className="riso-footer">
              <VenueAddress venue={venue} />
              <Admission event={event} />
            </div>
          </article>
        )}
        {active === 11 && (
          <article
            className="treatment blackout-bill"
            aria-label="Combined show and map tile"
          >
            <div className="blackout-date">
              <span>{weekday}</span>
              <strong>
                {month} {day}
              </strong>
              <span>{time}</span>
            </div>
            <div className="blackout-title">
              <span className="eyebrow">TURN IT UP / {venue.city}</span>
              <h2>{headlinerName}</h2>
              <Support names={supportNames} />
            </div>
            <div className="blackout-band">
              <div className="blackout-venue">
                <VenueAddress venue={venue} />
                <MapCaption venue={venue} />
              </div>
              <MapArtwork venue={venue} />
            </div>
            <div className="blackout-footer">
              <span>LIVE. LOUD. TOGETHER.</span>
              <Admission event={event} />
            </div>
          </article>
        )}
        {active === 12 && (
          <article
            className="treatment route-board"
            aria-label="Combined show and map tile"
          >
            <div className="route-header">
              <span className="eyebrow">SHOW DESTINATION</span>
              <span>{venue.city}</span>
            </div>
            <div className="route-map">
              <MapArtwork venue={venue} wallpaper focusMarker />
            </div>
            <div className="route-copy">
              <h2>{headlinerName}</h2>
              <Support names={supportNames} />
              <div className="route-itinerary">
                <div className="route-when">
                  <span className="route-dot" />
                  <span className="eyebrow">WHEN</span>
                  <strong>
                    {month} {day} <span>· {time}</span>
                  </strong>
                  <p>{weekday}</p>
                </div>
                <div className="route-where">
                  <span className="route-dot" />
                  <span className="eyebrow">WHERE</span>
                  <VenueAddress venue={venue} />
                </div>
              </div>
              <div className="route-footer">
                <Admission event={event} />
                <MapCaption venue={venue} />
              </div>
            </div>
          </article>
        )}
        {active === 13 && (
          <article
            className="treatment platform-pass"
            aria-label="Combined show and map tile"
          >
            <div className="platform-spine">
              <span>{month}</span>
              <strong>{String(day).padStart(2, "0")}</strong>
              <span>{weekday.slice(0, 3)}</span>
              <span className="platform-year">{date.getFullYear()}</span>
            </div>
            <div className="platform-main">
              <div className="platform-header">
                <span className="eyebrow">LIVE / {venue.city}</span>
                <strong>{time}</strong>
              </div>
              <h2>{headlinerName}</h2>
              <Support names={supportNames} />
              <div className="platform-destination">
                <div>
                  <span className="eyebrow">DESTINATION</span>
                  <VenueAddress venue={venue} />
                  <MapCaption venue={venue} />
                </div>
                <MapArtwork venue={venue} />
              </div>
              <div className="platform-footer">
                <Admission event={event} />
                <span className="platform-bars" aria-hidden="true" />
              </div>
            </div>
          </article>
        )}
      </div>
      <nav className="prototype-switcher" aria-label="Tile treatment switcher">
        <div className="switcher-main">
          <button
            onClick={() => choose(active - 1)}
            aria-label="Previous treatment"
          >
            ←
          </button>
          <div>
            <span>
              EXPERIMENT · {active} / {treatments.length}
            </span>
            <strong>{study.name}</strong>
          </div>
          <button
            onClick={() => choose(active + 1)}
            aria-label="Next treatment"
          >
            →
          </button>
        </div>
        <div className="switcher-dots">
          {treatments.map((treatment, index) => (
            <button
              key={treatment.name}
              onClick={() => choose(index + 1)}
              aria-label={`${index + 1}: ${treatment.name}`}
              aria-pressed={active === index + 1}
            >
              {index + 1}
            </button>
          ))}
        </div>
      </nav>
    </div>
  );
}
