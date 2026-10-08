# Company Brain: Infrastructure Discussion

> **Your product should share the infrastructure and semantic machinery, not Riverton's business schema.**

This is the architectural question to solve before Riverton's database accidentally becomes the product. Think about it in three layers.

---

## 1. Shared product layer

This is basically the same for every company:

```text
Tenant
User
Source
Document
Evidence
EntityType
Entity
Alias
RelationshipType
Relationship
Fact
Permission
SyncState
```

Those are **Company Brain concepts**, not Riverton concepts.

```text
entities
--------
id
tenant_id
entity_type_id
canonical_name
properties JSONB
created_at
updated_at
```

```text
entity_types
------------
id
tenant_id
name
schema
```

Riverton could define:

```text
Employee
Customer
Vendor
Asset
WorkOrder
Pump
Location
```

Another customer could define:

```text
Employee
Restaurant
Franchisee
DeliveryPlatform
DoorDashDispute
RefundClaim
Order
```

Same underlying machinery. That's the big unlock.

---

## 2. The ontology is tenant-specific

This is the part that **doesn't transfer**.

For Riverton:

```text
Customer
  HAS_SITE → Location

Asset
  LOCATED_AT → Site

Employee
  EXPERT_ON → AssetType

WorkOrder
  SERVICES → Asset
```

For Prepproof:

```text
Restaurant
  RECEIVES_ORDER_FROM → DeliveryPlatform

Order
  HAS_DISPUTE → Dispute

Dispute
  SUBMITTED_TO → DoorDash

Refund
  RESOLVES → Dispute
```

These are completely different businesses. But structurally, they're both:

```text
ENTITY
   ↓
RELATIONSHIP
   ↓
ENTITY
```

That's the reusable part.

---

## Should there be an `employees` table?

For **the product**, don't start with these as universal hard-coded tables:

```text
employees
customers
vendors
assets
work_orders
```

Start with:

```text
entity_types
entities
relationship_types
relationships
facts
aliases
```

For example:

```text
entity_types

id: et_123
tenant_id: riverton
name: Employee
schema:
{
  "title": "string",
  "department": "string",
  "hire_date": "date"
}
```

Then an employee:

```text
entities

id: ent_839
tenant_id: riverton
entity_type: Employee
canonical_name: "Mike Hargrove"

properties:
{
  "title": "Senior Field Technician",
  "location": "Louisville",
  "hire_date": "2012-07-01"
}
```

Another customer could have a completely different `Employee` schema. And Riverton could invent `KesslerZXRebuildProcedure` without needing a migration to the SaaS database.

---

## But don't go full generic EAV hell

There's a trap here. You don't want everything stored as rows like this:

```text
attribute_name | attribute_value
title          | "Technician"
hire_date      | "2020-01-01"
...
```

That becomes awful to query. Instead, use:

- **normal Postgres columns** for universal product metadata, and
- **JSONB** for tenant-specific entity properties.

```sql
entities

id
tenant_id
entity_type_id
canonical_name
description
properties jsonb
valid_from
valid_to
created_at
updated_at
```

Postgres is very good at querying and indexing JSONB when needed. Once something deserves stronger structure, promote it to a real column.

---

## Where `tenant_id` comes in

```text
tenant A = Riverton
tenant B = Acme Dental
tenant C = Some PE portfolio company
```

```text
tenant_id     entity_type     name
-----------------------------------------
riverton      Employee        Mike Hargrove
riverton      Customer        Blue Ridge
riverton      Asset           Pump 17

acme          Employee        Jane Lee
acme          Patient         ...
acme          Procedure       ...
```

Every query is scoped (`WHERE tenant_id = 'riverton'`), plus **row-level security (RLS)**.

Same idea in Elasticsearch (`tenant_id: riverton`) and S3:

```text
s3://company-brain/
    riverton/
    customer-b/
    customer-c/
```

The product is multi-tenant without every tenant having identical business objects.

---

## Should every customer get their own Postgres?

You *could*, but don't start there. There are three isolation levels:

```text
LEVEL 1
Shared Postgres
shared tables
tenant_id everywhere

LEVEL 2
Shared Postgres server
separate database/schema per customer

LEVEL 3
Dedicated infrastructure
dedicated Postgres
dedicated Elastic
dedicated S3/KMS
```

**Start with Level 1.** For a $14M business there's no technical reason Riverton needs its own RDS instance. Per-customer databases create operational pain: migrations, monitoring, backups and schema upgrades multiply with every customer.

```text
                COMPANY BRAIN
                     │
       ┌─────────────┼─────────────┐
       │             │             │
   Riverton       Customer B    Customer C
 tenant_id=A     tenant_id=B   tenant_id=C
```

RLS gives isolation in Postgres. Large or regulated enterprise customers can later pay for dedicated infrastructure.

---

## What transfers from the demo to Customer #1?

A **lot more than it feels like right now.**

**The ingestion pipeline:**

```text
connect source
↓
save original to S3
↓
extract / normalize
↓
create evidence
↓
AI enrichment
↓
entity resolution
↓
facts / relationships
↓
Elastic projection
```

**The shared Postgres core:**

```text
tenants
sources
source_objects

documents
document_versions
evidence

entity_types
entities
entity_aliases

relationship_types
relationships

facts
fact_versions

permissions
resource_acl

sync_state
ingestion_jobs
```

**The Elasticsearch model:**

```text
tenant_id
evidence_id
content
source
entities
timestamp
authority
permissions
embedding
provenance
```

**The UI:** search, entity cards, timelines, citations, source preview, graphs, tables, charts, the AI assistant, skills, and permission-aware results.

**The agents:**

```text
search_company()
get_entity()
get_relationships()
get_current_facts()
get_timeline()
open_source()
```

**What changes from customer to customer:**

```text
ontology
entity types
relationships
jargon
aliases
extraction rules
source mappings
business-specific skills
```

**That is exactly what the FDE configures.**

---

## Think of the platform like an operating system

You are not building "Riverton software". You're building:

```text
                  COMPANY BRAIN PLATFORM

Storage        S3
Database       Postgres
Search         Elasticsearch
Ingestion      Docling / AssemblyAI / Twelve Labs
Permissions    shared framework
AI             shared runtime
Agents         shared runtime
UI             shared components
                       │
                       ▼
              TENANT CONFIGURATION
                       │
          ┌────────────┼─────────────┐
          ▼            ▼             ▼
       Riverton     Company B      Company C

       Employee     Employee       Doctor
       Pump         Property       Patient
       Customer     Tenant         Procedure
       WorkOrder    Lease          Claim
```

This is why the ontology matters so much.

- **The platform supplies the grammar.**
- **The FDE learns the customer's vocabulary.**

---

## What this changes in the Riverton capstone

**Don't build Riverton tables as the application's domain model.** Avoid:

```text
riverton_customers
riverton_assets
riverton_work_orders
```

Build the generic Company Brain model, and configure Riverton's ontology **using the same mechanisms Customer #1 will use**.

Then, when the first real customer arrives and their key object turns out to be something you've never heard of (a `BatchTicket`, `ServiceTerritory`, `ChangeOrder` or `InspectionLot`), the response isn't:

> "Shit, I need to redesign the database."

It's:

> "Great. That's another entity type."
