ALTER TABLE "transactions" ADD COLUMN "lend_borrow_id" text;
--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_lend_borrow_id_unique" UNIQUE("lend_borrow_id");
--> statement-breakpoint
ALTER TABLE "lend_borrow" ADD COLUMN "transaction_id" text;
