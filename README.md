## Local execute

```
sam local invoke "PlaylistBackupFn"
```

## Deploy

```
sam deploy --template-file template.yaml --stack-name soundcloud-backup --s3-bucket mucadoo-cloudformation --region us-east-2 --capabilities CAPABILITY_NAMED_IAM --profile mucadoo
