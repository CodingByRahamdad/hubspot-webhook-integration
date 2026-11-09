// src/webhooks/objectTypes.js
// The CRM objects and classic event actions this receiver understands.
// To support a new object (for example "product"), add one line here.

// prefix of the classic subscriptionType (e.g. "company" in "company.creation") -> display label
const OBJECT_TYPES = {
  contact: 'Contact',
  company: 'Company',
  deal: 'Deal',
  ticket: 'Ticket',
};

// The three classic actions handled for every object above.
const ACTIONS = ['creation', 'propertyChange', 'deletion'];

module.exports = { OBJECT_TYPES, ACTIONS };
