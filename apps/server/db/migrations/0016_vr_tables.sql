CREATE TABLE `vr_cash_moves` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_id` int NOT NULL,
	`kind` enum('open','deposit','withdraw','adjust') NOT NULL,
	`amount_cents` int NOT NULL,
	`moved_on` date NOT NULL,
	`note` varchar(255),
	`cycle_id` int,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `vr_cash_moves_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `vr_cycles` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_id` int NOT NULL,
	`seq` int NOT NULL,
	`scheduled_start` date NOT NULL,
	`start_date` date NOT NULL,
	`v_cents` int NOT NULL,
	`band_min_cents` int NOT NULL,
	`band_max_cents` int NOT NULL,
	`open_shares` int NOT NULL,
	`open_pool_cents` int NOT NULL,
	`buy_budget_cents` int NOT NULL,
	`buy_lot` int NOT NULL,
	`sell_lot` int NOT NULL,
	`prev_close` bigint,
	`eval_cents` int,
	`pool_before_cents` int,
	`g` int NOT NULL,
	`formula` enum('basic','skill') NOT NULL,
	`deposit_cents` int NOT NULL DEFAULT 0,
	`v_kept` boolean NOT NULL DEFAULT false,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `vr_cycles_id` PRIMARY KEY(`id`),
	CONSTRAINT `vr_cycles_run_seq_unique` UNIQUE(`run_id`,`seq`)
);
--> statement-breakpoint
CREATE TABLE `vr_fills` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_id` int NOT NULL,
	`side` varchar(8) NOT NULL,
	`shares` int NOT NULL,
	`price` bigint NOT NULL,
	`fee` int NOT NULL,
	`filled_on` date NOT NULL,
	`source` enum('manual','capture') NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `vr_fills_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `vr_runs` (
	`run_id` int NOT NULL,
	`g` int NOT NULL,
	`formula` enum('basic','skill') NOT NULL,
	`band_ppm` int NOT NULL,
	`spend_limit_ppm` int NOT NULL,
	`cycle_deposit_cents` int NOT NULL DEFAULT 0,
	`initial_v_cents` int NOT NULL,
	CONSTRAINT `vr_runs_run_id` PRIMARY KEY(`run_id`)
);
--> statement-breakpoint
CREATE INDEX `vr_cash_moves_run_idx` ON `vr_cash_moves` (`run_id`);--> statement-breakpoint
CREATE INDEX `vr_fills_run_idx` ON `vr_fills` (`run_id`);