CREATE TABLE `buckets` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_id` int NOT NULL,
	`idx` int NOT NULL,
	`state` varchar(16) NOT NULL,
	`shares` int NOT NULL DEFAULT 0,
	`buy_price_myriadths` bigint,
	`buy_fee_cents` int NOT NULL DEFAULT 0,
	`filled_on` date,
	CONSTRAINT `buckets_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `captures` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_id` int NOT NULL,
	`chat_id` varchar(64) NOT NULL,
	`image_hash` varchar(128) NOT NULL,
	`status` enum('pending','parsed','unparseable','duplicate','confirmed') NOT NULL DEFAULT 'pending',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `captures_id` PRIMARY KEY(`id`),
	CONSTRAINT `captures_run_hash_unique` UNIQUE(`run_id`,`image_hash`)
);
--> statement-breakpoint
CREATE TABLE `fills` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_id` int NOT NULL,
	`bucket_idx` int NOT NULL,
	`side` varchar(8) NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`shares` int NOT NULL,
	`price` bigint NOT NULL,
	`fee` int NOT NULL,
	`filled_on` date NOT NULL,
	`source` enum('capture','manual','seed') NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `fills_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `ledger` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_id` int NOT NULL,
	`ts` timestamp NOT NULL DEFAULT (now()),
	`kind` varchar(32) NOT NULL,
	`amount_cents` int NOT NULL,
	`ref` text,
	CONSTRAINT `ledger_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_id` int,
	`chat_id` varchar(64) NOT NULL,
	`text` text NOT NULL,
	`sent_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `notifications_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `orders` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_id` int NOT NULL,
	`trade_date` date NOT NULL,
	`kind` enum('buy_loc','sell_loc','market_sell') NOT NULL,
	`bucket_idx` int NOT NULL,
	`limit_price` bigint NOT NULL,
	`shares` int NOT NULL,
	`status` enum('open','filled','stale','cancelled') NOT NULL DEFAULT 'open',
	`skip_reason` text,
	CONSTRAINT `orders_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `pending_fills` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_id` int NOT NULL,
	`capture_id` int,
	`bucket_idx` int NOT NULL,
	`side` varchar(8) NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`shares` int NOT NULL,
	`price` bigint NOT NULL,
	`fee` int NOT NULL,
	`filled_on` date NOT NULL,
	`status` enum('pending','confirmed','rejected') NOT NULL DEFAULT 'pending',
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `pending_fills_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `pool_edits` (
	`id` int AUTO_INCREMENT NOT NULL,
	`run_id` int NOT NULL,
	`pool_cents` int NOT NULL,
	`edited_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `pool_edits_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sim_days` (
	`id` int AUTO_INCREMENT NOT NULL,
	`sim_run_id` int NOT NULL,
	`trade_date` date NOT NULL,
	`plan_json` text NOT NULL,
	`state_json` text NOT NULL,
	`events_json` text NOT NULL,
	CONSTRAINT `sim_days_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `sim_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`from_date` date NOT NULL,
	`to_date` date NOT NULL,
	`pool_cents` int NOT NULL,
	`cost_ppm` int NOT NULL,
	`params_json` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `sim_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `strategy_runs` (
	`id` int AUTO_INCREMENT NOT NULL,
	`strategy_key` varchar(64) NOT NULL,
	`ticker` varchar(16) NOT NULL,
	`name` varchar(128) NOT NULL,
	`pool_cents` int NOT NULL,
	`cost_ppm` int NOT NULL,
	`status` enum('active','paused','closed','done') NOT NULL DEFAULT 'active',
	`state_json` text NOT NULL,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `strategy_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `strategy_runs_name_unique` UNIQUE(`name`)
);
