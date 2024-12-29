## Local execute

```
sam local invoke "PlaylistBackupFn"
```

## Deploy

```
sam deploy --stack-name ronda-web --s3-bucket mucadoo-cloudformation --region us-weast-1 --capabilities CAPABILITY_NAMED_IAM
