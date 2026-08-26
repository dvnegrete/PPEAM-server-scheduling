-- CreateEnum
CREATE TYPE "ParticipantStatus" AS ENUM ('ACTIVE', 'PAUSED', 'INACTIVE');

-- CreateEnum
CREATE TYPE "ParticipantRole" AS ENUM ('PARTICIPANT', 'SUPERVISOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "ShiftStatus" AS ENUM ('PLANNED', 'OPEN', 'FULL', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AssignmentOrigin" AS ENUM ('FIXED', 'SIGNUP', 'COVERAGE', 'MANUAL');

-- CreateEnum
CREATE TYPE "AssignmentStatus" AS ENUM ('ASSIGNED', 'CONFIRMED', 'CANCELLED', 'NO_SHOW');

-- CreateEnum
CREATE TYPE "CoverageRequestStatus" AS ENUM ('OPEN', 'FULFILLED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CoverageOfferStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'EXPIRED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "SupervisorTaskType" AS ENUM ('COVERAGE_APPROVAL', 'CANCELLATION_NOTICE', 'LOW_STAFF_ALERT', 'QUESTION', 'SIGNUP_REQUEST');

-- CreateEnum
CREATE TYPE "SupervisorTaskStatus" AS ENUM ('PENDING', 'CLAIMED', 'RESOLVED', 'AUTO_RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OutboxKind" AS ENUM ('TEXT', 'INTERACTIVE', 'TEMPLATE');

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ThreadStatus" AS ENUM ('OPEN', 'ANSWERED', 'CLOSED');

-- CreateEnum
CREATE TYPE "ThreadDirection" AS ENUM ('FROM_PARTICIPANT', 'FROM_SUPERVISOR');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('PARTICIPANT', 'SUPERVISOR', 'ADMIN', 'SYSTEM');

-- CreateTable
CREATE TABLE "locations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT,
    "timezone" TEXT NOT NULL DEFAULT 'America/Mexico_City',
    "default_capacity" INTEGER NOT NULL DEFAULT 3,
    "min_capacity" INTEGER NOT NULL DEFAULT 2,
    "max_capacity" INTEGER NOT NULL DEFAULT 4,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "whatsapp_group_jid" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "participants" (
    "id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "display_name" TEXT,
    "phone_e164" TEXT NOT NULL,
    "status" "ParticipantStatus" NOT NULL DEFAULT 'ACTIVE',
    "role" "ParticipantRole" NOT NULL DEFAULT 'PARTICIPANT',
    "coverage_alerts" BOOLEAN NOT NULL DEFAULT true,
    "opt_in_at" TIMESTAMP(3),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "participants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "location_memberships" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "participant_id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shift_templates" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "capacity" INTEGER NOT NULL DEFAULT 3,
    "week_of_month" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "auto_fill_only" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shift_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "recurring_assignments" (
    "id" TEXT NOT NULL,
    "shift_template_id" TEXT NOT NULL,
    "participant_id" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "starts_on" DATE,
    "ends_on" DATE,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "recurring_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shifts" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "template_id" TEXT,
    "date" DATE NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "ends_at" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "week_of_month" INTEGER NOT NULL,
    "status" "ShiftStatus" NOT NULL DEFAULT 'PLANNED',
    "cancelled_at" TIMESTAMP(3),
    "cancelled_reason" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "shifts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "assignments" (
    "id" TEXT NOT NULL,
    "shift_id" TEXT NOT NULL,
    "participant_id" TEXT NOT NULL,
    "origin" "AssignmentOrigin" NOT NULL DEFAULT 'FIXED',
    "status" "AssignmentStatus" NOT NULL DEFAULT 'ASSIGNED',
    "confirmed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "reminded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coverage_requests" (
    "id" TEXT NOT NULL,
    "shift_id" TEXT NOT NULL,
    "slots_needed" INTEGER NOT NULL DEFAULT 1,
    "slots_filled" INTEGER NOT NULL DEFAULT 0,
    "status" "CoverageRequestStatus" NOT NULL DEFAULT 'OPEN',
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "published_at" TIMESTAMP(3),
    "broadcast_count" INTEGER NOT NULL DEFAULT 0,
    "closes_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coverage_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "coverage_offers" (
    "id" TEXT NOT NULL,
    "coverage_request_id" TEXT NOT NULL,
    "participant_id" TEXT NOT NULL,
    "offered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "CoverageOfferStatus" NOT NULL DEFAULT 'PENDING',
    "decided_at" TIMESTAMP(3),
    "decided_by_id" TEXT,

    CONSTRAINT "coverage_offers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supervisor_windows" (
    "id" TEXT NOT NULL,
    "participant_id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "start_minute" INTEGER NOT NULL,
    "end_minute" INTEGER NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supervisor_windows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supervisor_presence" (
    "id" TEXT NOT NULL,
    "participant_id" TEXT NOT NULL,
    "available" BOOLEAN NOT NULL,
    "until" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supervisor_presence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supervisor_tasks" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "type" "SupervisorTaskType" NOT NULL,
    "status" "SupervisorTaskStatus" NOT NULL DEFAULT 'PENDING',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "urgent" BOOLEAN NOT NULL DEFAULT false,
    "shift_id" TEXT,
    "coverage_request_id" TEXT,
    "thread_id" TEXT,
    "requester_id" TEXT,
    "claimed_by_id" TEXT,
    "claimed_at" TIMESTAMP(3),
    "resolved_by_id" TEXT,
    "resolved_at" TIMESTAMP(3),
    "resolution" TEXT,
    "due_at" TIMESTAMP(3) NOT NULL,
    "auto_resolved_at" TIMESTAMP(3),
    "notified_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supervisor_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "question_threads" (
    "id" TEXT NOT NULL,
    "location_id" TEXT NOT NULL,
    "participant_id" TEXT NOT NULL,
    "status" "ThreadStatus" NOT NULL DEFAULT 'OPEN',
    "subject" TEXT,
    "last_message_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "question_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "thread_messages" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "direction" "ThreadDirection" NOT NULL,
    "author_id" TEXT,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "thread_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox_messages" (
    "id" TEXT NOT NULL,
    "to_phone" TEXT NOT NULL,
    "participant_id" TEXT,
    "kind" "OutboxKind" NOT NULL,
    "template_name" TEXT,
    "payload" JSONB NOT NULL,
    "status" "OutboxStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sent_at" TIMESTAMP(3),
    "wa_message_id" TEXT,
    "error" TEXT,
    "dedupe_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outbox_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inbound_messages" (
    "id" TEXT NOT NULL,
    "wa_message_id" TEXT NOT NULL,
    "from_phone" TEXT NOT NULL,
    "participant_id" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "inbound_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_sessions" (
    "id" TEXT NOT NULL,
    "participant_id" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'IDLE',
    "context" JSONB NOT NULL DEFAULT '{}',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" TEXT NOT NULL,
    "actor_type" "ActorType" NOT NULL,
    "actor_id" TEXT,
    "actor_name" TEXT,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entity_id" TEXT,
    "before" JSONB,
    "after" JSONB,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_login_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "admin_users_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "participants_phone_e164_key" ON "participants"("phone_e164");

-- CreateIndex
CREATE INDEX "participants_status_idx" ON "participants"("status");

-- CreateIndex
CREATE UNIQUE INDEX "location_memberships_location_id_participant_id_key" ON "location_memberships"("location_id", "participant_id");

-- CreateIndex
CREATE INDEX "shift_templates_location_id_active_idx" ON "shift_templates"("location_id", "active");

-- CreateIndex
CREATE UNIQUE INDEX "shift_templates_location_id_weekday_start_minute_week_of_mo_key" ON "shift_templates"("location_id", "weekday", "start_minute", "week_of_month");

-- CreateIndex
CREATE UNIQUE INDEX "recurring_assignments_shift_template_id_participant_id_key" ON "recurring_assignments"("shift_template_id", "participant_id");

-- CreateIndex
CREATE INDEX "shifts_location_id_starts_at_idx" ON "shifts"("location_id", "starts_at");

-- CreateIndex
CREATE INDEX "shifts_status_starts_at_idx" ON "shifts"("status", "starts_at");

-- CreateIndex
CREATE UNIQUE INDEX "shifts_location_id_date_start_minute_key" ON "shifts"("location_id", "date", "start_minute");

-- CreateIndex
CREATE INDEX "assignments_participant_id_status_idx" ON "assignments"("participant_id", "status");

-- CreateIndex
CREATE INDEX "assignments_shift_id_status_idx" ON "assignments"("shift_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "assignments_shift_id_participant_id_key" ON "assignments"("shift_id", "participant_id");

-- CreateIndex
CREATE INDEX "coverage_requests_status_closes_at_idx" ON "coverage_requests"("status", "closes_at");

-- CreateIndex
CREATE INDEX "coverage_requests_shift_id_status_idx" ON "coverage_requests"("shift_id", "status");

-- CreateIndex
CREATE INDEX "coverage_offers_coverage_request_id_status_offered_at_idx" ON "coverage_offers"("coverage_request_id", "status", "offered_at");

-- CreateIndex
CREATE UNIQUE INDEX "coverage_offers_coverage_request_id_participant_id_key" ON "coverage_offers"("coverage_request_id", "participant_id");

-- CreateIndex
CREATE INDEX "supervisor_windows_location_id_weekday_active_idx" ON "supervisor_windows"("location_id", "weekday", "active");

-- CreateIndex
CREATE UNIQUE INDEX "supervisor_windows_participant_id_location_id_weekday_start_key" ON "supervisor_windows"("participant_id", "location_id", "weekday", "start_minute");

-- CreateIndex
CREATE UNIQUE INDEX "supervisor_presence_participant_id_key" ON "supervisor_presence"("participant_id");

-- CreateIndex
CREATE INDEX "supervisor_tasks_status_due_at_idx" ON "supervisor_tasks"("status", "due_at");

-- CreateIndex
CREATE INDEX "supervisor_tasks_location_id_status_type_idx" ON "supervisor_tasks"("location_id", "status", "type");

-- CreateIndex
CREATE INDEX "question_threads_status_last_message_at_idx" ON "question_threads"("status", "last_message_at");

-- CreateIndex
CREATE INDEX "thread_messages_thread_id_created_at_idx" ON "thread_messages"("thread_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_messages_dedupe_key_key" ON "outbox_messages"("dedupe_key");

-- CreateIndex
CREATE INDEX "outbox_messages_status_next_attempt_at_idx" ON "outbox_messages"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "inbound_messages_wa_message_id_key" ON "inbound_messages"("wa_message_id");

-- CreateIndex
CREATE INDEX "inbound_messages_from_phone_received_at_idx" ON "inbound_messages"("from_phone", "received_at");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_sessions_participant_id_key" ON "conversation_sessions"("participant_id");

-- CreateIndex
CREATE INDEX "conversation_sessions_expires_at_idx" ON "conversation_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "audit_logs_entity_entity_id_created_at_idx" ON "audit_logs"("entity", "entity_id", "created_at");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users"("email");

-- AddForeignKey
ALTER TABLE "location_memberships" ADD CONSTRAINT "location_memberships_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "location_memberships" ADD CONSTRAINT "location_memberships_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shift_templates" ADD CONSTRAINT "shift_templates_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_assignments" ADD CONSTRAINT "recurring_assignments_shift_template_id_fkey" FOREIGN KEY ("shift_template_id") REFERENCES "shift_templates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_assignments" ADD CONSTRAINT "recurring_assignments_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shifts" ADD CONSTRAINT "shifts_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "shift_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "assignments" ADD CONSTRAINT "assignments_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coverage_requests" ADD CONSTRAINT "coverage_requests_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coverage_offers" ADD CONSTRAINT "coverage_offers_coverage_request_id_fkey" FOREIGN KEY ("coverage_request_id") REFERENCES "coverage_requests"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coverage_offers" ADD CONSTRAINT "coverage_offers_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "coverage_offers" ADD CONSTRAINT "coverage_offers_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervisor_windows" ADD CONSTRAINT "supervisor_windows_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervisor_windows" ADD CONSTRAINT "supervisor_windows_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervisor_presence" ADD CONSTRAINT "supervisor_presence_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervisor_tasks" ADD CONSTRAINT "supervisor_tasks_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervisor_tasks" ADD CONSTRAINT "supervisor_tasks_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "shifts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervisor_tasks" ADD CONSTRAINT "supervisor_tasks_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "question_threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervisor_tasks" ADD CONSTRAINT "supervisor_tasks_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervisor_tasks" ADD CONSTRAINT "supervisor_tasks_claimed_by_id_fkey" FOREIGN KEY ("claimed_by_id") REFERENCES "participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supervisor_tasks" ADD CONSTRAINT "supervisor_tasks_resolved_by_id_fkey" FOREIGN KEY ("resolved_by_id") REFERENCES "participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_threads" ADD CONSTRAINT "question_threads_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "question_threads" ADD CONSTRAINT "question_threads_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread_messages" ADD CONSTRAINT "thread_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "question_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "thread_messages" ADD CONSTRAINT "thread_messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_messages" ADD CONSTRAINT "outbox_messages_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inbound_messages" ADD CONSTRAINT "inbound_messages_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_sessions" ADD CONSTRAINT "conversation_sessions_participant_id_fkey" FOREIGN KEY ("participant_id") REFERENCES "participants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
