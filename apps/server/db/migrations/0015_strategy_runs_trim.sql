ALTER TABLE `strategy_runs`
	DROP COLUMN IF EXISTS `pool_cents`,
	DROP COLUMN IF EXISTS `buy_gap_ppm`,
	DROP COLUMN IF EXISTS `sell_gap_ppm`,
	DROP COLUMN IF EXISTS `cut_loss_ppm`,
	DROP COLUMN IF EXISTS `state_json`;
