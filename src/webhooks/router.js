// src/webhooks/router.js
// Routes ONE classic event to a handler based on its action.
// routeEvent() returns true if the type is RECOGNIZED, false otherwise. It never throws.
// "Recognized" only means we know the type and logged it. These handlers do not
// create, update, or delete anything, so no business operation is performed.

const { OBJECT_TYPES } = require('./objectTypes');
const { normalizeEvent } = require('./normalizeEvent');

// Prints the details every classic event has (property fields only if present).
function logCommonDetails(event) {
  console.log(`  Event ID:        ${event.eventId}`);
  console.log(`  Subscription ID: ${event.subscriptionId}`);
  console.log(`  Portal ID:       ${event.portalId}`);
  console.log(`  Event type:      ${event.subscriptionType}`);
  console.log(`  Occurred at:     ${event.occurredAt}`);
  console.log(`  CRM object ID:   ${event.objectId}`);
  if (event.propertyName !== undefined) {
    console.log(`  Property name:   ${event.propertyName}`);
  }
  if (event.propertyValue !== undefined) {
    console.log(`  Property value:  ${event.propertyValue}`);
  }
}

// One handler per action. "label" is e.g. "Company". Add an object-specific
// hook here later if one object ever needs different behaviour.
const ACTION_HANDLERS = {
  creation: (label, e) => console.log(`  -> New ${label.toLowerCase()} created (ID ${e.objectId}).`),
  propertyChange: (label, e) =>
    console.log(
      `  -> ${label} ${e.objectId} property "${e.propertyName}" changed to "${e.propertyValue}".`
    ),
  deletion: (label, e) => console.log(`  -> ${label} ${e.objectId} was deleted.`),
};

function routeEvent(raw) {
  const event = normalizeEvent(raw);

  if (!event.valid) {
    console.warn(`  [WARNING] ${event.reason}`);
    return false;
  }

  logCommonDetails(event);

  if (event.objectType === null) {
    console.warn(`  -> Unknown event type "${event.subscriptionType}". Ignoring it.`);
    return false;
  }

  ACTION_HANDLERS[event.action](OBJECT_TYPES[event.objectType], event);
  return true;
}

module.exports = { routeEvent };
