ALTER TABLE `pending_fills` ADD `detected_order_type` varchar(32);--> statement-breakpoint
ALTER TABLE `pending_fills` ADD `detected_order_price` bigint;--> statement-breakpoint
ALTER TABLE `pending_fills` ADD `detected_ordered_shares` int;