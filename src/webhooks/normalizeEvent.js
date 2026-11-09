// src/webhooks/normalizeEvent.js
// Turns one raw classic HubSpot event into a predictable shape.
// It never throws. Invalid items return { valid: false, reason }.

const { OBJECT_TYPES, ACTIONS } = require('./objectTypes');

function normalizeEvent(raw) {
  // Each item must be a plain object (not null, a number, an array, ...).
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { valid: false, reason: 'Skipping item: it is not a JSON object.' };
  }

  // Without subscriptionType we cannot route the event.
  if (typeof raw.subscriptionType !== 'string') {
    return { valid: false, reason: 'Skipping event: missing "subscriptionType".' };
  }

  // "company.propertyChange" -> prefix "company", action "propertyChange".
  const [prefix, action, ...rest] = raw.subscriptionType.split('.');
  const supported =
    rest.length === 0 &&
    Object.prototype.hasOwnProperty.call(OBJECT_TYPES, prefix) &&
    ACTIONS.includes(action);

  const event = {
    valid: true,
    eventId: raw.eventId,
    subscriptionId: raw.subscriptionId,
    portalId: raw.portalId,
    subscriptionType: raw.subscriptionType,
    occurredAt: raw.occurredAt,
    objectId: raw.objectId,
    objectType: supported ? prefix : null, // null = not a supported type
    action: supported ? action : null,
  };

  // Only present on propertyChange events.
  if (raw.propertyName !== undefined) event.propertyName = raw.propertyName;
  if (raw.propertyValue !== undefined) event.propertyValue = raw.propertyValue;

  return event;
}

module.exports = { normalizeEvent };
