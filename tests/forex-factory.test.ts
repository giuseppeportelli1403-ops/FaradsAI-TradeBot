// Tests for parseForexFactoryXml — B3 (2026-04-28). Forex Factory's
// fairEconomy.media XML feed is the de-facto industry-standard FX
// economic-calendar source. We parse without a full XML library to keep
// the dependency surface small.
import { describe, it, expect } from 'vitest';
import { parseForexFactoryXml } from '../src/news/forex-factory-calendar.js';

describe('parseForexFactoryXml', () => {
  it('returns [] on empty / malformed input', () => {
    expect(parseForexFactoryXml('')).toEqual([]);
    expect(parseForexFactoryXml('not xml')).toEqual([]);
    expect(parseForexFactoryXml('<weeklyevents></weeklyevents>')).toEqual([]);
  });

  it('parses a single high-impact USD event', () => {
    const xml = `<?xml version="1.0" encoding="utf-8" ?>
<weeklyevents>
  <event>
    <title>Non-Farm Payrolls</title>
    <country>USD</country>
    <date>04-28-2026</date>
    <time>8:30am</time>
    <impact>High</impact>
    <forecast>200K</forecast>
    <previous>180K</previous>
  </event>
</weeklyevents>`;
    const events = parseForexFactoryXml(xml);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('Non-Farm Payrolls');
    expect(events[0].country).toBe('US'); // mapped from USD
    expect(events[0].impact).toBe('high');
    expect(events[0].date).toBe('2026-04-28');
    expect(events[0].time).toBe('08:30:00');
    expect(events[0].estimate).toBe('200K');
    expect(events[0].previous).toBe('180K');
  });

  it('maps FF currency codes to country codes for the calendar veto', () => {
    const xml = `<weeklyevents>
      <event>
        <title>ECB Rate Decision</title>
        <country>EUR</country>
        <date>04-30-2026</date>
        <time>1:45pm</time>
        <impact>High</impact>
        <forecast>4.50%</forecast>
        <previous>4.50%</previous>
      </event>
      <event>
        <title>BoE Bank Rate</title>
        <country>GBP</country>
        <date>05-01-2026</date>
        <time>12:00pm</time>
        <impact>High</impact>
        <forecast>5.25%</forecast>
        <previous>5.25%</previous>
      </event>
    </weeklyevents>`;
    const events = parseForexFactoryXml(xml);
    expect(events).toHaveLength(2);
    expect(events[0].country).toBe('EU');
    expect(events[0].time).toBe('13:45:00');
    expect(events[1].country).toBe('GB');
    expect(events[1].time).toBe('12:00:00');
  });

  it('handles "All Day" events as midnight UTC', () => {
    const xml = `<weeklyevents>
      <event>
        <title>French Holiday</title>
        <country>EUR</country>
        <date>05-01-2026</date>
        <time>All Day</time>
        <impact>Holiday</impact>
        <forecast></forecast>
        <previous></previous>
      </event>
    </weeklyevents>`;
    const events = parseForexFactoryXml(xml);
    expect(events).toHaveLength(1);
    expect(events[0].time).toBe('00:00:00');
    expect(events[0].impact).toBe('low'); // Holiday → low (not high/medium)
  });

  it('skips events with malformed dates', () => {
    const xml = `<weeklyevents>
      <event>
        <title>Bad event</title>
        <country>USD</country>
        <date>nonsense</date>
        <time>8:30am</time>
        <impact>High</impact>
      </event>
    </weeklyevents>`;
    expect(parseForexFactoryXml(xml)).toHaveLength(0);
  });

  it('handles ISO-formatted dates as a future-proof fallback', () => {
    // FF historically uses MM-DD-YYYY but newer feeds may emit ISO.
    const xml = `<weeklyevents>
      <event>
        <title>Tomorrow's CPI</title>
        <country>USD</country>
        <date>2026-04-29</date>
        <time>8:30am</time>
        <impact>High</impact>
      </event>
    </weeklyevents>`;
    const events = parseForexFactoryXml(xml);
    expect(events[0].date).toBe('2026-04-29');
  });

  it('parses multiple impact levels correctly', () => {
    const xml = `<weeklyevents>
      <event><title>A</title><country>USD</country><date>04-28-2026</date><time>9:00am</time><impact>High</impact></event>
      <event><title>B</title><country>USD</country><date>04-28-2026</date><time>10:00am</time><impact>Medium</impact></event>
      <event><title>C</title><country>USD</country><date>04-28-2026</date><time>11:00am</time><impact>Low</impact></event>
    </weeklyevents>`;
    const events = parseForexFactoryXml(xml);
    expect(events.map((e) => e.impact)).toEqual(['high', 'medium', 'low']);
  });

  it('handles CDATA-wrapped fields', () => {
    const xml = `<weeklyevents>
      <event>
        <title><![CDATA[Core PCE Price Index m/m]]></title>
        <country>USD</country>
        <date>04-30-2026</date>
        <time>8:30am</time>
        <impact>High</impact>
        <forecast><![CDATA[0.3%]]></forecast>
        <previous><![CDATA[0.2%]]></previous>
      </event>
    </weeklyevents>`;
    const events = parseForexFactoryXml(xml);
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe('Core PCE Price Index m/m');
    expect(events[0].estimate).toBe('0.3%');
  });

  it('correctly converts 12-hour to 24-hour time including PM and 12am edge', () => {
    const xml = `<weeklyevents>
      <event><title>A</title><country>USD</country><date>04-28-2026</date><time>12:00am</time><impact>Low</impact></event>
      <event><title>B</title><country>USD</country><date>04-28-2026</date><time>12:00pm</time><impact>Low</impact></event>
      <event><title>C</title><country>USD</country><date>04-28-2026</date><time>11:30pm</time><impact>Low</impact></event>
    </weeklyevents>`;
    const events = parseForexFactoryXml(xml);
    expect(events.map((e) => e.time)).toEqual(['00:00:00', '12:00:00', '23:30:00']);
  });
});
