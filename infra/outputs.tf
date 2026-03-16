output "audio_bucket_name" {
  description = "Cloud Storage bucket for audio files"
  value       = google_storage_bucket.audio.name
}

output "transcripts_bucket_name" {
  description = "Cloud Storage bucket for transcript JSON files"
  value       = google_storage_bucket.transcripts.name
}

output "cloud_sql_instance_name" {
  description = "Cloud SQL instance name"
  value       = google_sql_database_instance.main.name
}

output "cloud_sql_connection_name" {
  description = "Cloud SQL instance connection name"
  value       = google_sql_database_instance.main.connection_name
}

output "cloud_tasks_queue_name" {
  description = "Cloud Tasks transcription queue name"
  value       = google_cloud_tasks_queue.transcription.name
}

output "notetaker_bot_sa_email" {
  description = "Notetaker bot service account email"
  value       = google_service_account.notetaker_bot.email
}

output "transcription_worker_sa_email" {
  description = "Transcription worker service account email"
  value       = google_service_account.transcription_worker.email
}

output "pipeline_sa_email" {
  description = "Pipeline service account email"
  value       = google_service_account.pipeline.email
}
